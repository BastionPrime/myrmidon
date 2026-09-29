// server/src/myrmidon/bot-containers/docker-driver.ts
//
// BotContainerDriver implementation over the Docker Engine HTTP API, spoken
// directly over the daemon's unix socket with node:http (no docker client
// dependency — CONVENTIONS.md §8). This is the pilot driver
// (containers-plan-senior-2026-09-28.md §1.4 "intermediate step"): the board still
// holds the socket. Moving the socket out to a separate `fleetd` process later only
// means constructing a different BotContainerDriver in index.ts; this module's
// template enforcement (template.ts) is written so that move can reuse it as-is.
//
// How files reach a bot's volumes. The bot container runs with a read-only root
// filesystem, and Docker refuses `PUT /containers/{id}/archive` into any path of
// such a container that is not inside one of its volumes (moby
// daemon/archive_unix.go: "container rootfs is marked read-only"). So:
//   - every archive is PUT to one volume mount point (`/data/hermes`,
//     `/workspace`, `/scratch`), with entry paths relative to it — never to "/";
//   - the archive carries explicit directory entries (uid 10001, mode 0700)
//     before any file, because Docker creates a missing parent directory itself as
//     root:root 0755, which the uid-10001 swap below could then not modify;
//   - the archive only ever lands in a per-apply staging directory, and a
//     short-lived helper container (same image, uid 10001, no network, every
//     capability dropped, the bot's three binds and nothing else) moves the staged
//     files into place. A helper — not `docker exec` in the bot — because exec
//     needs the bot to be running, and a stopped, crash-looping or freshly created
//     container is exactly when a new profile has to be written.
//   - Volume directories themselves are created by Docker (as root) when a bind
//     source is missing; a second helper, run as root with only CAP_CHOWN and
//     CAP_FOWNER, hands them to uid 10001 with mode 0700 before first use.
//
// Applied state. Docker cannot change a container's labels after creation, so no
// label says what is applied. The swap moves a marker file
// (hermes/.myrmidon/applied.json: both hashes plus the list of profile paths) into
// place as its very last step, and status() reads it back with
// `GET /containers/{id}/archive`, which works in every container state. No marker
// means "nothing verified applied", never "unchanged".
//
// Secrets and the image. The create body carries no `Env`: anything there is
// shown by `docker inspect`. API_SERVER_KEY and every other secret reach the
// gateway only as the profile's hermes/.env, so the image has to read them from
// there. Whether it does is part of the runtime contract an image declares
// (template.ts BOT_RUNTIME_CONTRACT_LABEL); create/recreate refuse an image
// that does not declare it, before anything is created.

import { randomBytes } from "node:crypto";
import http from "node:http";
import type { BotContainerDriver, BotContainerSpec, BotContainerStatus } from "./driver.js";
import type { CompiledProfile } from "./types.js";
import {
  assertBotRuntimeContract,
  BOT_LABEL_KEYS,
  BOT_MANAGED_DIRS,
  BOT_KEY_PATTERN,
  BOT_VOLUME_MOUNTS,
  BotContainerTemplateError,
  buildBinds,
  buildLabels,
  containerNameFor,
  helperContainerNameFor,
  isImageAllowed,
  isUnderManagedDir,
  mountRootSegment,
  parseImageAllowlist,
  replacementContainerNameFor,
  resolveProfileFileTarget,
  validateBotKey,
} from "./template.js";
import { buildUstarArchive, parseUstarArchive, type UstarEntry } from "./ustar.js";

export const BOT_DOCKER_SOCKET_ENV = "MYRMIDON_BOT_DOCKER_SOCKET";
export const DEFAULT_BOT_DOCKER_SOCKET = "/var/run/docker.sock";
export const BOT_IMAGE_ALLOWLIST_ENV = "MYRMIDON_BOT_IMAGE_ALLOWLIST";
export const BOT_VOLUME_ROOT_ENV = "MYRMIDON_BOT_VOLUME_ROOT";
export const BOT_NETWORK_ENV = "MYRMIDON_BOT_NETWORK";
export const DEFAULT_BOT_NETWORK = "myrmidon-bots";

/** uid:gid the image runs the gateway as (non-root; the bot image's `USER`).
 *  Profile files and every directory the driver creates are owned by it. */
export const BOT_CONTAINER_UID = 10001;

const DOCKER_API_VERSION = "v1.45";
/** Seconds Docker waits after SIGTERM before SIGKILL on stop/restart. */
export const BOT_STOP_TIMEOUT_SEC = 30;
const DEFAULT_START_HEALTH_TIMEOUT_MS = 120_000;
const DEFAULT_HEALTH_POLL_INTERVAL_MS = 1_000;
const REQUEST_TIMEOUT_MS = 60_000;
const HELPER_WAIT_TIMEOUT_MS = 120_000;
const HELPER_MEMORY_BYTES = 128 * 1024 * 1024;
const HELPER_PIDS_LIMIT = 64;

const HERMES_MOUNT = BOT_VOLUME_MOUNTS.find((mount) => mount.hostSuffix === "hermes")!;
/** Applied-state marker, relative to the hermes mount. */
const MARKER_RELATIVE_PATH = ".myrmidon/applied.json";
export const APPLIED_MARKER_CONTAINER_PATH = `${HERMES_MOUNT.containerPath}/${MARKER_RELATIVE_PATH}`;

export interface DockerDriverConfig {
  socketPath: string;
  volumeRoot: string;
  network: string;
  allowlist: readonly string[];
}

export function readDockerDriverConfig(env: NodeJS.ProcessEnv = process.env): DockerDriverConfig {
  const volumeRoot = env[BOT_VOLUME_ROOT_ENV]?.trim();
  if (!volumeRoot) {
    throw new BotContainerTemplateError(`${BOT_VOLUME_ROOT_ENV} must be set to use the bot container driver`);
  }
  return {
    socketPath: env[BOT_DOCKER_SOCKET_ENV]?.trim() || DEFAULT_BOT_DOCKER_SOCKET,
    volumeRoot,
    network: env[BOT_NETWORK_ENV]?.trim() || DEFAULT_BOT_NETWORK,
    allowlist: parseImageAllowlist(env[BOT_IMAGE_ALLOWLIST_ENV]),
  };
}

/** Test hooks; production code passes none. */
export interface DockerDriverOptions {
  sleep?: (ms: number) => Promise<void>;
  startHealthTimeoutMs?: number;
  healthPollIntervalMs?: number;
  /** Staging-directory nonce generator (hex). */
  nonce?: () => string;
}

export interface DockerCreateContainerBody {
  Image: string;
  Labels: Record<string, string>;
  HostConfig: {
    Memory: number;
    NanoCpus: number;
    PidsLimit: number;
    CapDrop: string[];
    SecurityOpt: string[];
    ReadonlyRootfs: boolean;
    Tmpfs: Record<string, string>;
    Init: boolean;
    RestartPolicy: { Name: string };
    NetworkMode: string;
    Binds: string[];
    Privileged: boolean;
  };
}

/**
 * Pure builder for the `POST /containers/create` body — the actual "fixed
 * template" enforcement. Never adds anything a caller passed beyond `spec`'s
 * fields: no arbitrary binds, no host network, no privileged mode, and no
 * `Env` (secrets travel only in the profile's hermes/.env). Throws on an
 * image outside the allowlist or a network other than the one configured for
 * this driver.
 */
export function buildCreateContainerRequestBody(
  spec: BotContainerSpec,
  config: Pick<DockerDriverConfig, "volumeRoot" | "network" | "allowlist">,
): DockerCreateContainerBody {
  validateBotKey(spec.botKey);
  if (!isImageAllowed(spec.image, config.allowlist)) {
    throw new BotContainerTemplateError(`image "${spec.image}" is not in ${BOT_IMAGE_ALLOWLIST_ENV}`);
  }
  if (spec.network !== config.network) {
    throw new BotContainerTemplateError(
      `network "${spec.network}" does not match this driver's ${BOT_NETWORK_ENV} ("${config.network}")`,
    );
  }
  if (spec.memoryMb <= 0 || spec.cpus <= 0 || spec.pidsLimit <= 0) {
    throw new BotContainerTemplateError("memoryMb, cpus and pidsLimit must all be positive");
  }
  return {
    Image: spec.image,
    Labels: buildLabels(spec),
    HostConfig: {
      Memory: Math.round(spec.memoryMb * 1024 * 1024),
      NanoCpus: Math.round(spec.cpus * 1_000_000_000),
      PidsLimit: spec.pidsLimit,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges"],
      ReadonlyRootfs: true,
      Tmpfs: { "/tmp": "" },
      Init: true,
      RestartPolicy: { Name: "on-failure" },
      NetworkMode: config.network,
      Binds: buildBinds(config.volumeRoot, spec.botKey),
      Privileged: false,
    },
  };
}

export type HelperRole = "prepare-volumes" | "apply-profile";

export interface DockerHelperContainerBody {
  Image: string;
  User: string;
  Entrypoint: string[];
  Cmd: string[];
  Labels: Record<string, string>;
  NetworkDisabled: boolean;
  HostConfig: {
    Memory: number;
    PidsLimit: number;
    CapDrop: string[];
    CapAdd: string[];
    SecurityOpt: string[];
    ReadonlyRootfs: boolean;
    RestartPolicy: { Name: string };
    NetworkMode: string;
    Binds: string[];
    Privileged: boolean;
  };
}

/**
 * Pure builder for a helper container: the bot's own image with its entrypoint
 * replaced by `/bin/sh -c <script> myrmidon-helper /`, the bot's three binds and
 * nothing else, no network, every capability dropped. "prepare-volumes" runs as
 * root with CAP_CHOWN and CAP_FOWNER added back — just enough to chmod/chown the
 * three mount points; "apply-profile" runs as the bot's own uid with no
 * capability at all. The script is always driver-generated (buildApplyScript /
 * buildPrepareVolumesScript) and contains no profile data.
 */
export function buildHelperContainerRequestBody(params: {
  botKey: string;
  image: string;
  role: HelperRole;
  script: string;
  volumeRoot: string;
}): DockerHelperContainerBody {
  validateBotKey(params.botKey);
  const asRoot = params.role === "prepare-volumes";
  return {
    Image: params.image,
    User: asRoot ? "0:0" : `${BOT_CONTAINER_UID}:${BOT_CONTAINER_UID}`,
    Entrypoint: ["/bin/sh", "-c"],
    Cmd: [params.script, "myrmidon-helper", "/"],
    Labels: { [BOT_LABEL_KEYS.helper]: params.botKey },
    NetworkDisabled: true,
    HostConfig: {
      Memory: HELPER_MEMORY_BYTES,
      PidsLimit: HELPER_PIDS_LIMIT,
      CapDrop: ["ALL"],
      CapAdd: asRoot ? ["CHOWN", "FOWNER"] : [],
      SecurityOpt: ["no-new-privileges"],
      ReadonlyRootfs: true,
      RestartPolicy: { Name: "no" },
      NetworkMode: "none",
      Binds: buildBinds(params.volumeRoot, params.botKey),
      Privileged: false,
    },
  };
}

const MOUNT_ROOTS = BOT_VOLUME_MOUNTS.map((mount) => mountRootSegment(mount));
const NONCE_PATTERN = /^[0-9a-f]{8,64}$/;

function stagingDirName(nonce: string): string {
  return `.myrmidon-next-${nonce}`;
}

function applyDirName(nonce: string): string {
  return `.myrmidon-apply-${nonce}`;
}

/** Script the "prepare-volumes" helper runs (as root, CAP_CHOWN + CAP_FOWNER):
 *  hands each mount point to the bot's uid with mode 0700. Idempotent. Paths are
 *  relative to "$1" (the container root in production). */
export function buildPrepareVolumesScript(): string {
  return [
    "set -eu",
    'cd "$1"',
    `for d in ${MOUNT_ROOTS.join(" ")}; do`,
    '  chmod 0700 "$d"',
    `  chown ${BOT_CONTAINER_UID}:${BOT_CONTAINER_UID} "$d"`,
    "done",
  ].join("\n");
}

/**
 * Script the "apply-profile" helper runs (as the bot's uid) after the staged
 * archives have been PUT. Paths are relative to "$1" (the container root in
 * production). In order:
 *   1. drop staging left behind by any earlier, interrupted apply (any other
 *      nonce), so its files can never be moved into place by this one;
 *   2. replace every compiler-owned directory (BOT_MANAGED_DIRS) wholesale:
 *      the live one is renamed aside, the staged one renamed into place — a skill
 *      removed from the card disappears instead of lingering;
 *   3. move every other staged file over its final path (`mv` is an atomic
 *      rename within the volume), creating parent directories as needed;
 *   4. delete files the previous apply wrote that this profile no longer has
 *      (the list is computed by the driver and staged as remove.list);
 *   5. only then move the applied-state marker into place, and clean up.
 * `set -e` aborts at the first failure, before the marker moves, so a partial
 * apply is never reported as applied and the next pass simply repeats it.
 * No profile path is ever interpolated into this text: the only variable part
 * is the hex nonce.
 */
export function buildApplyScript(nonce: string): string {
  if (!NONCE_PATTERN.test(nonce)) throw new BotContainerTemplateError(`invalid staging nonce "${nonce}"`);
  const hermesRoot = mountRootSegment(HERMES_MOUNT);
  const applyDir = `${hermesRoot}/${applyDirName(nonce)}`;
  const lines: string[] = [
    "set -eu",
    "umask 077",
    'cd "$1"',
    `n=${nonce}`,
    "# 1. staging from interrupted earlier applies",
    `for root in ${MOUNT_ROOTS.join(" ")}; do`,
    '  for stale in "$root"/.myrmidon-next-* "$root"/.myrmidon-apply-* "$root"/.myrmidon-old-*; do',
    '    [ -e "$stale" ] || continue',
    '    case "${stale#"$root"/}" in',
    '      ".myrmidon-next-$n" | ".myrmidon-apply-$n") ;;',
    '      *) rm -rf -- "$stale" ;;',
    "    esac",
    "  done",
    "done",
    "# 2. compiler-owned directories, replaced wholesale",
  ];
  BOT_MANAGED_DIRS.forEach((dir, index) => {
    const { mount, relativePath } = resolveProfileFileTarget({ path: dir });
    const root = mountRootSegment(mount);
    lines.push(
      `staged="${root}/.myrmidon-next-$n/${relativePath}"`,
      `live="${root}/${relativePath}"`,
      'if [ -d "$staged" ]; then',
      `  old="${root}/.myrmidon-old-$n"`,
      '  mkdir -p -- "$old"',
      `  if [ -e "$live" ] || [ -L "$live" ]; then mv -f -T -- "$live" "$old/${index}"; fi`,
      '  mkdir -p -- "$(dirname -- "$live")"',
      '  mv -f -T -- "$staged" "$live"',
      "fi",
    );
  });
  lines.push(
    "# 3. every other staged file, one atomic rename each",
    `list="${applyDir}/staged.list"`,
    `for root in ${MOUNT_ROOTS.join(" ")}; do`,
    '  staging="$root/.myrmidon-next-$n"',
    '  [ -d "$staging" ] || continue',
    '  (cd "$staging" && find . -type f) > "$list"',
    '  while IFS= read -r rel; do',
    '    rel="${rel#./}"',
    '    mkdir -p -- "$(dirname -- "$root/$rel")"',
    '    mv -f -T -- "$staging/$rel" "$root/$rel"',
    '  done < "$list"',
    "done",
    "# 4. files the previous apply wrote that this profile no longer has",
    `removals="${applyDir}/remove.list"`,
    'if [ -f "$removals" ]; then',
    '  while IFS= read -r p; do',
    '    case "$p" in',
  );
  for (const mount of BOT_VOLUME_MOUNTS) {
    lines.push(`      ${mount.hostSuffix}/*) dest="${mountRootSegment(mount)}/\${p#${mount.hostSuffix}/}" ;;`);
  }
  lines.push(
    "      *) continue ;;",
    "    esac",
    '    if [ -f "$dest" ] || [ -L "$dest" ]; then rm -f -- "$dest"; fi',
    '  done < "$removals"',
    "fi",
    "# 5. the applied-state marker, strictly last",
    `mkdir -p -- "${hermesRoot}/${MARKER_RELATIVE_PATH.split("/")[0]}"`,
    `mv -f -T -- "${applyDir}/applied.json" "${hermesRoot}/${MARKER_RELATIVE_PATH}"`,
    `rm -rf -- ${MOUNT_ROOTS.map((root) => `"${root}/.myrmidon-next-$n"`).join(" ")} "${applyDir}" "${hermesRoot}/.myrmidon-old-$n"`,
  );
  return lines.join("\n");
}

export interface AppliedMarker {
  restartHash: string;
  filesHash: string;
  /** Profile paths (CompiledProfileFile.path) this apply wrote. */
  files: string[];
}

export function serializeAppliedMarker(profile: CompiledProfile): string {
  const marker: AppliedMarker = {
    restartHash: profile.restartHash,
    filesHash: profile.filesHash,
    files: profile.files.map((file) => file.path).sort(),
  };
  return `${JSON.stringify(marker)}\n`;
}

/** Null for anything that is not a well-formed marker: the file lives on a
 *  volume the bot itself can write, so its content is data, not trusted state. */
export function parseAppliedMarker(raw: string): AppliedMarker | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const { restartHash, filesHash, files } = parsed as Record<string, unknown>;
  if (typeof restartHash !== "string" || typeof filesHash !== "string") return null;
  const fileList = Array.isArray(files) ? files.filter((path): path is string => typeof path === "string") : [];
  return { restartHash, filesHash, files: fileList };
}

/**
 * Profile paths an earlier apply wrote (from its marker) that `next` no longer
 * has, and that are not under a compiler-owned directory (those are replaced
 * wholesale anyway). Paths read back from the marker are re-validated with
 * resolveProfileFileTarget and silently dropped when unsafe — the marker lives
 * on a bot-writable volume.
 */
export function computeProfileRemovals(previous: readonly string[] | undefined, next: CompiledProfile): string[] {
  if (!previous) return [];
  const keep = new Set(next.files.map((file) => file.path));
  const removals = new Set<string>();
  for (const path of previous) {
    if (keep.has(path) || isUnderManagedDir(path)) continue;
    try {
      resolveProfileFileTarget({ path });
    } catch {
      continue;
    }
    removals.add(path);
  }
  return [...removals].sort();
}

export interface ProfileArchive {
  /** Container path of the volume mount point the archive is PUT to. */
  mountPath: string;
  entries: UstarEntry[];
}

function parentDirs(relativePath: string): string[] {
  const parts = relativePath.split("/");
  const out: string[] = [];
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join("/"));
  return out;
}

/**
 * Pure: the per-mount archives writeProfile PUTs. Each is relative to its
 * mount point and holds, in order, explicit directory entries (uid/gid 10001,
 * mode 0700: the staging directory, every parent of a staged file, and every
 * compiler-owned directory even when the profile puts nothing in it — that is
 * what empties it) and then the files. The hermes archive also carries the apply
 * metadata: the new marker and the removal list. Throws on an unsafe path, a
 * duplicate path, a file at a compiler-owned directory's own path, or a file
 * whose path another file uses as a directory.
 */
export function buildProfileArchives(
  profile: CompiledProfile,
  opts: { nonce: string; removals: readonly string[]; mtime?: Date },
): ProfileArchive[] {
  if (!NONCE_PATTERN.test(opts.nonce)) throw new BotContainerTemplateError(`invalid staging nonce "${opts.nonce}"`);
  const staging = stagingDirName(opts.nonce);
  const perMount = new Map<string, { dirs: Set<string>; files: UstarEntry[] }>();
  const bucket = (containerPath: string) => {
    let entry = perMount.get(containerPath);
    if (!entry) {
      entry = { dirs: new Set([staging]), files: [] };
      perMount.set(containerPath, entry);
    }
    return entry;
  };
  const owner = { uid: BOT_CONTAINER_UID, gid: BOT_CONTAINER_UID, mtime: opts.mtime };

  // The hermes archive always exists: it carries the marker and the managed
  // skills directory even when the profile has nothing else for it.
  bucket(HERMES_MOUNT.containerPath);
  for (const dir of BOT_MANAGED_DIRS) {
    const { mount, relativePath } = resolveProfileFileTarget({ path: dir });
    const target = bucket(mount.containerPath);
    const staged = `${staging}/${relativePath}`;
    for (const parent of parentDirs(staged)) target.dirs.add(parent);
    target.dirs.add(staged);
  }

  const seen = new Set<string>();
  for (const file of profile.files) {
    const { mount, relativePath } = resolveProfileFileTarget(file);
    if (seen.has(file.path)) {
      throw new BotContainerTemplateError(`profile lists ${JSON.stringify(file.path)} more than once`);
    }
    seen.add(file.path);
    if (BOT_MANAGED_DIRS.includes(file.path)) {
      throw new BotContainerTemplateError(`profile file ${JSON.stringify(file.path)} would replace a compiler-owned directory`);
    }
    const target = bucket(mount.containerPath);
    const staged = `${staging}/${relativePath}`;
    for (const parent of parentDirs(staged)) target.dirs.add(parent);
    target.files.push({
      ...owner,
      path: staged,
      content: Buffer.from(file.content, "utf8"),
      mode: file.secret ? 0o600 : file.mode & 0o777,
    });
  }

  const hermes = bucket(HERMES_MOUNT.containerPath);
  const applyDir = applyDirName(opts.nonce);
  hermes.dirs.add(applyDir);
  hermes.files.push(
    { ...owner, path: `${applyDir}/applied.json`, content: Buffer.from(serializeAppliedMarker(profile), "utf8"), mode: 0o600 },
    {
      ...owner,
      path: `${applyDir}/remove.list`,
      content: Buffer.from(opts.removals.map((path) => `${path}\n`).join(""), "utf8"),
      mode: 0o600,
    },
  );

  const archives: ProfileArchive[] = [];
  for (const mount of BOT_VOLUME_MOUNTS) {
    const target = perMount.get(mount.containerPath);
    if (!target) continue;
    for (const file of target.files) {
      if (target.dirs.has(file.path)) {
        throw new BotContainerTemplateError(`profile path "${file.path}" is used both as a file and as a directory`);
      }
    }
    const dirs = [...target.dirs].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
    archives.push({
      mountPath: mount.containerPath,
      entries: [
        ...dirs.map((path): UstarEntry => ({ ...owner, path, type: "directory", content: Buffer.alloc(0), mode: 0o700 })),
        ...[...target.files].sort((a, b) => a.path.localeCompare(b.path)),
      ],
    });
  }
  return archives;
}

interface DockerInspect {
  Id: string;
  /** Image id the container runs (sha256:…). */
  Image: string;
  Config?: { Image?: string; Labels?: Record<string, string> };
  State?: { Status?: string; ExitCode?: number; Health?: { Status?: string } };
  HostConfig?: { Memory?: number; NanoCpus?: number; PidsLimit?: number; NetworkMode?: string };
}

/**
 * Pure drift check: does `existing` (a container's live inspect) still match
 * `body` (a freshly built create-request) on every field that identifies the
 * container's *template* — image, the three resource limits and the network?
 */
export function containerTemplateDrifted(
  existing: Pick<DockerInspect, "Config" | "HostConfig">,
  body: DockerCreateContainerBody,
): boolean {
  return (
    existing.Config?.Image !== body.Image ||
    existing.HostConfig?.Memory !== body.HostConfig.Memory ||
    existing.HostConfig?.NanoCpus !== body.HostConfig.NanoCpus ||
    existing.HostConfig?.PidsLimit !== body.HostConfig.PidsLimit ||
    existing.HostConfig?.NetworkMode !== body.HostConfig.NetworkMode
  );
}

/**
 * Pure: a bot's state from its inspect. Health comes only from Docker's own
 * health check (`State.Health`, the image's HEALTHCHECK with its retries), never
 * from a one-off probe by the board: one slow answer, or the board simply not
 * being on the bot network, must not read as "unhealthy" and trigger a restart.
 * An image without a HEALTHCHECK is judged by its running state alone.
 */
export function botStateFromInspect(info: Pick<DockerInspect, "State">): "running" | "unhealthy" | "stopped" {
  if (info.State?.Status !== "running") return "stopped";
  return info.State.Health?.Status === "unhealthy" ? "unhealthy" : "running";
}

/** Docker's multiplexed log stream (no TTY): 8-byte frame headers. */
export function demuxDockerLogs(buf: Buffer): string {
  const chunks: Buffer[] = [];
  let offset = 0;
  while (offset + 8 <= buf.length) {
    const stream = buf[offset];
    if (stream > 2 || buf[offset + 1] !== 0 || buf[offset + 2] !== 0 || buf[offset + 3] !== 0) {
      return buf.toString("utf8");
    }
    const size = buf.readUInt32BE(offset + 4);
    chunks.push(buf.subarray(offset + 8, offset + 8 + size));
    offset += 8 + size;
  }
  return Buffer.concat(chunks).toString("utf8");
}

interface DockerHttpResponse {
  status: number;
  body: Buffer;
}

function dockerRequest(
  socketPath: string,
  opts: { method: string; path: string; body?: Buffer; headers?: Record<string, string>; timeoutMs?: number },
): Promise<DockerHttpResponse> {
  return new Promise((resolve, reject) => {
    const headers = { ...opts.headers };
    if (opts.body) headers["Content-Length"] = String(opts.body.length);
    const req = http.request(
      { socketPath, path: `/${DOCKER_API_VERSION}${opts.path}`, method: opts.method, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
      },
    );
    const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`docker API ${opts.method} ${opts.path} timed out after ${timeoutMs}ms`));
    });
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

function describeFailure(what: string, res: DockerHttpResponse): Error {
  return new Error(`${what} failed: ${res.status} ${res.body.toString("utf8").slice(0, 300)}`);
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Path segment for a container or image name in an API URL. */
function nameSegment(name: string): string {
  return name.split("/").map(encodeURIComponent).join("/");
}

/** Constructs a working driver from the environment; throws if MYRMIDON_BOT_VOLUME_ROOT
 *  is unset (evaluated lazily — only when the caller actually needs a driver, so
 *  importing this module never fails on a host that has bot containers disabled). */
export function dockerBotContainerDriver(
  config: DockerDriverConfig = readDockerDriverConfig(),
  options: DockerDriverOptions = {},
): BotContainerDriver {
  const { socketPath } = config;
  const sleep = options.sleep ?? realSleep;
  const startHealthTimeoutMs = options.startHealthTimeoutMs ?? DEFAULT_START_HEALTH_TIMEOUT_MS;
  const healthPollIntervalMs = options.healthPollIntervalMs ?? DEFAULT_HEALTH_POLL_INTERVAL_MS;
  const newNonce = options.nonce ?? (() => randomBytes(8).toString("hex"));

  const request = (opts: Parameters<typeof dockerRequest>[1]) => dockerRequest(socketPath, opts);

  async function requestJson<T>(opts: { method: string; path: string; body?: unknown; timeoutMs?: number }): Promise<T> {
    const res = await request({
      method: opts.method,
      path: opts.path,
      body: opts.body === undefined ? undefined : Buffer.from(JSON.stringify(opts.body), "utf8"),
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      timeoutMs: opts.timeoutMs,
    });
    if (res.status >= 400) throw describeFailure(`docker API ${opts.method} ${opts.path}`, res);
    if (res.body.length === 0) return undefined as T;
    return JSON.parse(res.body.toString("utf8")) as T;
  }

  async function inspectByName(name: string): Promise<DockerInspect | null> {
    const res = await request({ method: "GET", path: `/containers/${nameSegment(name)}/json` });
    if (res.status === 404) return null;
    if (res.status >= 400) throw describeFailure(`docker inspect ${name}`, res);
    return JSON.parse(res.body.toString("utf8")) as DockerInspect;
  }

  async function createNamed(name: string, body: unknown): Promise<void> {
    await requestJson({ method: "POST", path: `/containers/create?name=${encodeURIComponent(name)}`, body });
  }

  async function startByName(name: string): Promise<void> {
    const res = await request({ method: "POST", path: `/containers/${nameSegment(name)}/start` });
    if (res.status >= 400) throw describeFailure(`docker start ${name}`, res);
  }

  async function stopByName(name: string): Promise<void> {
    const res = await request({
      method: "POST",
      path: `/containers/${nameSegment(name)}/stop?t=${BOT_STOP_TIMEOUT_SEC}`,
      timeoutMs: (BOT_STOP_TIMEOUT_SEC + 30) * 1000,
    });
    if (res.status >= 400 && res.status !== 404) throw describeFailure(`docker stop ${name}`, res);
  }

  /** Removes a container and its anonymous volumes (`v=true` never touches a
   *  bind mount). Only ever called on a helper, a stale replacement, or a bot
   *  container that has already been stopped gracefully. */
  async function removeByName(name: string): Promise<void> {
    const res = await request({ method: "DELETE", path: `/containers/${nameSegment(name)}?force=true&v=true` });
    if (res.status >= 400 && res.status !== 404) throw describeFailure(`docker remove ${name}`, res);
  }

  /** The image must be on the host (the driver never pulls) and declare a
   *  supported bot runtime contract (template.ts BOT_RUNTIME_CONTRACT_LABEL). */
  async function requireBotImage(image: string): Promise<void> {
    const res = await request({ method: "GET", path: `/images/${nameSegment(image)}/json` });
    if (res.status === 404) {
      throw new Error(`image "${image}" is not present on the Docker host; build or pull it first (the driver never pulls)`);
    }
    if (res.status >= 400) throw describeFailure(`docker image inspect ${image}`, res);
    let labels: Record<string, string> | null | undefined;
    try {
      labels = (JSON.parse(res.body.toString("utf8")) as { Config?: { Labels?: Record<string, string> | null } }).Config?.Labels;
    } catch {
      labels = undefined;
    }
    assertBotRuntimeContract(image, labels);
  }

  async function putArchive(containerName: string, mountPath: string, archive: Buffer): Promise<void> {
    const res = await request({
      method: "PUT",
      path: `/containers/${nameSegment(containerName)}/archive?path=${encodeURIComponent(mountPath)}&noOverwriteDirNonDir=true`,
      body: archive,
      headers: { "Content-Type": "application/x-tar" },
    });
    if (res.status >= 400) throw describeFailure(`docker archive PUT to ${containerName}:${mountPath}`, res);
  }

  async function helperLogs(name: string): Promise<string> {
    try {
      const res = await request({ method: "GET", path: `/containers/${nameSegment(name)}/logs?stdout=true&stderr=true&tail=20` });
      if (res.status >= 400) return "";
      return demuxDockerLogs(res.body).trim().slice(-500);
    } catch {
      return "";
    }
  }

  /** Runs one helper container to completion and removes it. */
  async function runHelper(
    botKey: string,
    params: { image: string; role: HelperRole; script: string; archives?: readonly ProfileArchive[] },
  ): Promise<void> {
    const name = helperContainerNameFor(botKey);
    await removeByName(name); // a helper left over from an interrupted earlier run
    const body = buildHelperContainerRequestBody({
      botKey,
      image: params.image,
      role: params.role,
      script: params.script,
      volumeRoot: config.volumeRoot,
    });
    await createNamed(name, body);
    try {
      for (const archive of params.archives ?? []) {
        await putArchive(name, archive.mountPath, buildUstarArchive(archive.entries));
      }
      await startByName(name);
      const result = await requestJson<{ StatusCode?: number }>({
        method: "POST",
        path: `/containers/${nameSegment(name)}/wait?condition=not-running`,
        timeoutMs: HELPER_WAIT_TIMEOUT_MS,
      });
      if (result?.StatusCode !== 0) {
        const logs = await helperLogs(name);
        throw new Error(
          `${params.role} helper for ${containerNameFor(botKey)} exited with ${result?.StatusCode ?? "unknown status"}${logs ? `: ${logs}` : ""}`,
        );
      }
    } finally {
      await removeByName(name).catch(() => undefined);
    }
  }

  async function prepareVolumes(botKey: string, image: string): Promise<void> {
    await runHelper(botKey, { image, role: "prepare-volumes", script: buildPrepareVolumesScript() });
  }

  async function readAppliedMarker(botKey: string): Promise<AppliedMarker | null> {
    const name = containerNameFor(botKey);
    const res = await request({
      method: "GET",
      path: `/containers/${nameSegment(name)}/archive?path=${encodeURIComponent(APPLIED_MARKER_CONTAINER_PATH)}`,
    });
    if (res.status === 404) return null;
    // Any other failure is an error of this pass, not "nothing applied": guessing
    // either way would mean a needless drain-and-restart or a skipped update.
    if (res.status >= 400) throw describeFailure(`reading the applied-state marker of ${name}`, res);
    try {
      const file = parseUstarArchive(res.body).find((entry) => entry.type === "file");
      return file ? parseAppliedMarker(file.content.toString("utf8")) : null;
    } catch {
      return null; // corrupt marker: nothing verified applied
    }
  }

  async function status(botKey: string): Promise<BotContainerStatus> {
    const name = containerNameFor(botKey);
    const info = await inspectByName(name);
    if (!info) return { botKey, state: "missing" };
    const marker = await readAppliedMarker(botKey);
    return {
      botKey,
      state: botStateFromInspect(info),
      image: info.Config?.Image,
      restartHash: marker?.restartHash,
      filesHash: marker?.filesHash,
    };
  }

  async function list(): Promise<BotContainerStatus[]> {
    const filters = encodeURIComponent(JSON.stringify({ label: [BOT_LABEL_KEYS.bot] }));
    const containers = await requestJson<Array<{ Labels?: Record<string, string> }>>({
      method: "GET",
      path: `/containers/json?all=true&filters=${filters}`,
    });
    const botKeys = new Set<string>();
    for (const container of containers) {
      const botKey = container.Labels?.[BOT_LABEL_KEYS.bot];
      if (botKey && BOT_KEY_PATTERN.test(botKey)) botKeys.add(botKey);
    }
    const results: BotContainerStatus[] = [];
    for (const botKey of botKeys) results.push(await status(botKey));
    return results;
  }

  async function templateDrift(spec: BotContainerSpec): Promise<boolean> {
    const body = buildCreateContainerRequestBody(spec, config);
    const existing = await inspectByName(containerNameFor(spec.botKey));
    if (!existing) return false;
    return containerTemplateDrifted(existing, body);
  }

  async function create(spec: BotContainerSpec): Promise<void> {
    const body = buildCreateContainerRequestBody(spec, config);
    await requireBotImage(spec.image);
    await removeByName(replacementContainerNameFor(spec.botKey)); // stale, from an interrupted recreate
    await prepareVolumes(spec.botKey, spec.image);
    await createNamed(containerNameFor(spec.botKey), body);
  }

  async function recreate(spec: BotContainerSpec): Promise<void> {
    const body = buildCreateContainerRequestBody(spec, config);
    const name = containerNameFor(spec.botKey);
    const replacement = replacementContainerNameFor(spec.botKey);
    // Everything that can fail for a reason of its own (missing image, rejected
    // template, daemon refusing the create) happens while the old container is
    // still intact.
    await requireBotImage(spec.image);
    await removeByName(replacement);
    await prepareVolumes(spec.botKey, spec.image);
    await createNamed(replacement, body);
    // Only now touch the old one: SIGTERM, SIGKILL after BOT_STOP_TIMEOUT_SEC.
    await stopByName(name);
    await removeByName(name);
    const res = await request({
      method: "POST",
      path: `/containers/${nameSegment(replacement)}/rename?name=${encodeURIComponent(name)}`,
    });
    if (res.status >= 400) throw describeFailure(`docker rename ${replacement} -> ${name}`, res);
  }

  async function writeProfile(botKey: string, profile: CompiledProfile): Promise<void> {
    const name = containerNameFor(botKey);
    if (profile.botKey !== botKey) {
      throw new BotContainerTemplateError(`profile for "${profile.botKey}" cannot be written to bot "${botKey}"`);
    }
    const info = await inspectByName(name);
    if (!info) throw new Error(`${name} does not exist; create it before writing its profile`);
    const previous = await readAppliedMarker(botKey);
    const nonce = newNonce();
    const archives = buildProfileArchives(profile, { nonce, removals: computeProfileRemovals(previous?.files, profile) });
    await runHelper(botKey, { image: info.Image, role: "apply-profile", script: buildApplyScript(nonce), archives });
  }

  async function waitForHealthy(botKey: string): Promise<void> {
    const name = containerNameFor(botKey);
    const deadline = Date.now() + startHealthTimeoutMs;
    for (;;) {
      const info = await inspectByName(name);
      if (!info) throw new Error(`${name} disappeared while waiting for it to become healthy`);
      const state = info.State?.Status ?? "unknown";
      const health = info.State?.Health?.Status;
      if (state === "running" && (health === undefined || health === "healthy")) return;
      if (state === "running" && health === "unhealthy") throw new Error(`${name} reports unhealthy after start`);
      if (state === "exited" || state === "dead") {
        throw new Error(`${name} ${state} (exit code ${info.State?.ExitCode ?? "unknown"}) instead of becoming healthy`);
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `${name} did not become healthy within ${startHealthTimeoutMs}ms (last state: ${health ? `${state}/${health}` : state})`,
        );
      }
      await sleep(healthPollIntervalMs);
    }
  }

  async function start(botKey: string): Promise<void> {
    await startByName(containerNameFor(botKey)); // 304 (already running) is not an error
    await waitForHealthy(botKey);
  }

  async function restart(botKey: string): Promise<void> {
    const name = containerNameFor(botKey);
    const res = await request({
      method: "POST",
      path: `/containers/${nameSegment(name)}/restart?t=${BOT_STOP_TIMEOUT_SEC}`,
      timeoutMs: (BOT_STOP_TIMEOUT_SEC + 30) * 1000,
    });
    if (res.status >= 400) throw describeFailure(`docker restart ${name}`, res);
    await waitForHealthy(botKey);
  }

  async function stop(botKey: string): Promise<void> {
    await stopByName(containerNameFor(botKey));
  }

  return { status, list, templateDrift, create, recreate, writeProfile, start, restart, stop };
}
