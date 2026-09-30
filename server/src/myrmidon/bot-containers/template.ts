// server/src/myrmidon/bot-containers/template.ts
//
// Pure helpers for the docker-driver's fixed container template
// (containers-plan-senior-2026-09-28.md §1.4: "fleetd is not a Docker API proxy, it
// is a service with a fixed template"). Everything here is deterministic and does no
// I/O, so the driver's tests cover it directly without a Docker socket.
// This is also the enforcement boundary: a BotContainerSpec coming from an agent's
// adapterConfig (index.ts) cannot smuggle in an arbitrary image, bind mount or
// network, and a compiled profile file cannot address anything outside its own
// volume or the driver's reserved bookkeeping paths — only what these functions
// accept ever reaches the Docker API.

import type { BotContainerSpec, BotExtraMount } from "./driver.js";
import type { CompiledProfileFile } from "./types.js";

// DNS label rules (RFC 1123) plus the same character set as the tar/exec paths
// below assume: no ".", no "/", nothing that could escape MYRMIDON_BOT_VOLUME_ROOT.
export const BOT_KEY_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export class BotContainerTemplateError extends Error {}

export function validateBotKey(botKey: string): void {
  if (!BOT_KEY_PATTERN.test(botKey)) {
    throw new BotContainerTemplateError(`invalid bot key "${botKey}": must match ${BOT_KEY_PATTERN}`);
  }
}

export function containerNameFor(botKey: string): string {
  validateBotKey(botKey);
  return `myrmidon-bot-${botKey}`;
}

/** Name of the short-lived helper container the driver uses to prepare a bot's
 *  volumes and to lay its profile down. The "." separator cannot occur in a bot
 *  key (BOT_KEY_PATTERN), so this can never collide with another bot's own
 *  container name ("myrmidon-bot-<key>-helper" could: bot key "<key>-helper"). */
export function helperContainerNameFor(botKey: string): string {
  return `${containerNameFor(botKey)}.helper`;
}

/** Name a replacement container is created under during a template-drift
 *  recreate, before it is renamed over the old one. Same "." reasoning as above. */
export function replacementContainerNameFor(botKey: string): string {
  return `${containerNameFor(botKey)}.next`;
}

/** MYRMIDON_BOT_IMAGE_ALLOWLIST: comma-separated globs. `*` matches any run of
 *  characters other than "/", so a pattern never crosses a path segment. */
export function parseImageAllowlist(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** MYRMIDON_BOT_MOUNT_SOURCES: comma-separated absolute host directories a
 *  card's `container.extraMounts` may name as a `source`. Instance-wide and
 *  operator-controlled: a card can only pick from this list, never invent a
 *  path. An entry that is not a plain absolute directory (see
 *  `unsafeAbsolutePathReason`) can never match a mount and is dropped. */
export const BOT_MOUNT_SOURCES_ENV = "MYRMIDON_BOT_MOUNT_SOURCES";

export function parseMountSourceAllowlist(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function escapeRegExpLiteral(chunk: string): string {
  return chunk.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

function globToRegExp(glob: string): RegExp {
  const pattern = glob
    .split("*")
    .map((chunk) => escapeRegExpLiteral(chunk))
    .join("[^/]*");
  return new RegExp(`^${pattern}$`);
}

export function isImageAllowed(image: string, allowlist: readonly string[]): boolean {
  return allowlist.some((glob) => globToRegExp(glob).test(image));
}

export interface BotVolumeMount {
  /** Path segment under MYRMIDON_BOT_VOLUME_ROOT/<botKey>, e.g. "hermes". Also the
   *  required first path segment of a CompiledProfileFile.path that belongs here. */
  hostSuffix: "hermes" | "workspace" | "scratch";
  /** Absolute mount point inside the container. */
  containerPath: string;
}

/** The only three mounts a bot container ever gets. Fixed on purpose: see the
 *  module comment above. */
export const BOT_VOLUME_MOUNTS: readonly BotVolumeMount[] = [
  { hostSuffix: "hermes", containerPath: "/data/hermes" },
  { hostSuffix: "workspace", containerPath: "/workspace" },
  { hostSuffix: "scratch", containerPath: "/scratch" },
];

/** The fixed bind list for a bot, plus the extra read-only mounts its card asked
 *  for. Callers supply a botKey and (optionally) mount entries whose `source`
 *  already comes from the instance allowlist — never a raw path — so a card
 *  cannot smuggle in an arbitrary bind. A mount whose source is not in
 *  `MYRMIDON_BOT_MOUNT_SOURCES`, or whose container path would take over one of
 *  the driver's own mount points, throws before anything reaches the Docker API. */
export function buildBinds(
  volumeRoot: string,
  botKey: string,
  extra: { mounts?: readonly BotExtraMount[]; allowedSources?: readonly string[] } = {},
): string[] {
  validateBotKey(botKey);
  const mounts = extra.mounts ?? [];
  validateExtraMounts(mounts, extra.allowedSources ?? []);
  return [
    ...BOT_VOLUME_MOUNTS.map((mount) => `${volumeRoot}/${botKey}/${mount.hostSuffix}:${mount.containerPath}`),
    ...mounts.map((mount) => `${mount.source}:${mount.containerPath}:ro`),
  ];
}

/** Mount points and paths the driver itself owns inside every bot container: an
 *  extra mount may neither take one of them over nor shadow a path under them
 *  (the profile lands in the three volumes, and `/tmp` is the image's tmpfs). */
const RESERVED_CONTAINER_PATHS: readonly string[] = [...BOT_VOLUME_MOUNTS.map((mount) => mount.containerPath), "/tmp"];

/** Why `value` is not usable as an absolute host directory or container mount
 *  point, or null when it is. Deliberately strict: no relative form, no "..",
 *  no empty segment, no trailing slash, no backslash or control character, and
 *  not the filesystem root — so two spellings of the same directory can never
 *  compare unequal. */
function unsafeAbsolutePathReason(value: string): string | null {
  if (!value.startsWith("/")) return "is not an absolute path";
  if (value.length === 1) return "is the filesystem root";
  if (hasControlCharacter(value)) return "contains a control character";
  if (value.includes("\\")) return "contains a backslash";
  if (value.includes("//")) return "has an empty path segment";
  if (value.endsWith("/")) return "has a trailing slash";
  for (const segment of value.split("/")) {
    if (segment === "." || segment === "..") return `has a "${segment}" path segment`;
  }
  return null;
}

/**
 * Throws unless every extra mount may be mounted into a bot container:
 *  - `source` is a plain absolute directory and is listed in
 *    `MYRMIDON_BOT_MOUNT_SOURCES` (exact match — no prefix rule, so a card
 *    cannot reach a sibling directory the operator did not name);
 *  - `containerPath` is a plain absolute path that is not one of the driver's
 *    own mount points (or a path under one) and is not used twice;
 *  - `readOnly` is true: a shared directory is never mounted writable.
 * The check is the enforcement boundary, so it does not trust the card reader
 * (`agent-config.ts`) to have validated the list first.
 */
export function validateExtraMounts(mounts: readonly BotExtraMount[], allowedSources: readonly string[]): void {
  const allowed = new Set(allowedSources.filter((source) => unsafeAbsolutePathReason(source) === null));
  const taken = new Set<string>(RESERVED_CONTAINER_PATHS);
  for (const [index, mount] of mounts.entries()) {
    const where = `extra mount #${index + 1}`;
    const sourceReason = unsafeAbsolutePathReason(mount.source);
    if (sourceReason) {
      throw new BotContainerTemplateError(`${where} source ${JSON.stringify(mount.source)} ${sourceReason}`);
    }
    if (!allowed.has(mount.source)) {
      throw new BotContainerTemplateError(
        `${where} source ${JSON.stringify(mount.source)} is not listed in ${BOT_MOUNT_SOURCES_ENV}`,
      );
    }
    if (mount.readOnly !== true) {
      throw new BotContainerTemplateError(`${where} of ${JSON.stringify(mount.source)} must be read-only`);
    }
    const pathReason = unsafeAbsolutePathReason(mount.containerPath);
    if (pathReason) {
      throw new BotContainerTemplateError(`${where} path ${JSON.stringify(mount.containerPath)} ${pathReason}`);
    }
    const clashes = RESERVED_CONTAINER_PATHS.some(
      (reserved) => mount.containerPath === reserved || mount.containerPath.startsWith(`${reserved}/`),
    );
    if (clashes || taken.has(mount.containerPath)) {
      throw new BotContainerTemplateError(
        `${where} path ${JSON.stringify(mount.containerPath)} is reserved by the driver or used twice`,
      );
    }
    taken.add(mount.containerPath);
  }
}

/** `mount.containerPath` without its leading "/", e.g. "data/hermes". This is the
 *  path segment to use for anything addressed *inside* the container relative to
 *  its root (the apply script's paths) — never `mount.hostSuffix`, which only
 *  names the bind's source directory under MYRMIDON_BOT_VOLUME_ROOT and does not
 *  match the mount point for "hermes" (host suffix "hermes" mounts to
 *  "/data/hermes", not "/hermes"). */
export function mountRootSegment(mount: BotVolumeMount): string {
  return mount.containerPath.replace(/^\//, "");
}

/**
 * Directories (as profile paths) that the profile compiler owns outright: on
 * every apply their whole content is replaced by exactly what the new profile
 * carries under them — including nothing at all — instead of being merged file
 * by file. "hermes/skills-board" is the compiler's copy of the card's skills
 * (Hermes reads the whole directory through `skills.external_dirs`), so a skill
 * removed from the card must disappear from it; a per-file merge never removes
 * anything. The bot's own skills live elsewhere under hermes/ and are untouched.
 */
export const BOT_MANAGED_DIRS: readonly string[] = ["hermes/skills-board"];

/** True when a profile path is a managed directory itself or lies under one. */
export function isUnderManagedDir(profilePath: string): boolean {
  return BOT_MANAGED_DIRS.some((dir) => profilePath === dir || profilePath.startsWith(`${dir}/`));
}

/** Prefix of every path segment the driver reserves for its own bookkeeping at a
 *  mount root: the applied-state marker (".myrmidon/"), the per-apply staging
 *  (".myrmidon-next-<nonce>/"), the apply metadata (".myrmidon-apply-<nonce>/")
 *  and the set-aside copy of a replaced managed directory (".myrmidon-old-<nonce>/"). */
export const RESERVED_SEGMENT_PREFIX = ".myrmidon";

export const BOT_LABEL_KEYS = {
  bot: "myrmidon.bot",
  image: "myrmidon.image",
  /** Set on the driver's helper containers instead of `bot`, so they never show
   *  up as a bot in `list()`. */
  helper: "myrmidon.bot-helper",
} as const;

/**
 * Image label through which a bot runtime image declares the runtime contract
 * this driver relies on. Being present on the host and matching
 * MYRMIDON_BOT_IMAGE_ALLOWLIST is not enough: create/recreate refuse an image
 * that does not declare one of SUPPORTED_BOT_RUNTIME_CONTRACTS, before
 * anything is created (docker-driver.ts). An image that exists but was built
 * for another contract would otherwise only fail after the container is
 * created and started, and then crash-loop under its restart policy on every
 * pass.
 *
 * Contract "1":
 *  - the gateway runs as uid:gid 10001:10001 with HERMES_HOME=/data/hermes and
 *    /workspace as its working directory: the driver mounts exactly
 *    /data/hermes, /workspace and /scratch, owned by 10001, mode 0700;
 *  - every secret the gateway needs, API_SERVER_KEY included, is read from
 *    $HERMES_HOME/.env (dotenv `KEY="value"` lines, read as data and never
 *    executed by a shell). The driver never puts a secret in the container's
 *    environment, where `docker inspect` shows it, so the image must not
 *    require one there;
 *  - it writes nothing outside those three mounts, /tmp (a tmpfs) and volumes
 *    the image declares itself: the driver runs it with a read-only root
 *    filesystem;
 *  - /bin/sh with find, mv (with -T), mkdir -p, rm, chmod, chown and dirname:
 *    the driver's helper containers run its scripts with the image's own shell.
 */
export const BOT_RUNTIME_CONTRACT_LABEL = "myrmidon.bot-runtime.contract";
export const SUPPORTED_BOT_RUNTIME_CONTRACTS: readonly string[] = ["1"];

/** Throws unless the image labels (`Config.Labels` of `GET /images/{name}/json`,
 *  which Docker returns as null for an image without labels) declare a
 *  supported bot runtime contract. */
export function assertBotRuntimeContract(image: string, labels: Record<string, string> | null | undefined): void {
  const declared = labels?.[BOT_RUNTIME_CONTRACT_LABEL];
  if (declared !== undefined && SUPPORTED_BOT_RUNTIME_CONTRACTS.includes(declared)) return;
  const wanted = SUPPORTED_BOT_RUNTIME_CONTRACTS.map((version) => `${BOT_RUNTIME_CONTRACT_LABEL}=${version}`).join(" or ");
  throw new BotContainerTemplateError(
    declared === undefined
      ? `image "${image}" does not declare the bot runtime contract (image label ${wanted}); ` +
          "nothing is created from an image not known to take API_SERVER_KEY from $HERMES_HOME/.env"
      : `image "${image}" declares bot runtime contract "${declared}", this driver supports only ${wanted}`,
  );
}

/**
 * Identification labels for a bot container. Deliberately carries no profile
 * hashes: Docker cannot change a container's labels after creation, so a hash
 * label would only ever mean "desired when the container was created", never
 * "applied" — and treating it as applied state is exactly what let a failed
 * first profile write look like a finished one. Applied state lives only in the
 * marker file writeProfile moves into place last (docker-driver.ts).
 *
 * The driver's own keys always win over anything in `spec.labels` — a caller
 * cannot use that field to spoof `myrmidon.bot` and hide a container from
 * `list()`'s orphan scan, nor tag one as a helper.
 */
export function buildLabels(spec: Pick<BotContainerSpec, "botKey" | "image" | "labels">): Record<string, string> {
  const labels: Record<string, string> = { ...spec.labels };
  delete labels[BOT_LABEL_KEYS.helper];
  return {
    ...labels,
    [BOT_LABEL_KEYS.bot]: spec.botKey,
    [BOT_LABEL_KEYS.image]: spec.image,
  };
}

/** ASCII control characters (NUL, newline, ...) and DEL. A newline would also
 *  split an entry of the apply script's removal list in two. */
function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** Why `rest` (the part of a profile file's path after its "hermes/" /
 *  "workspace/" / "scratch/" prefix) is unsafe, or null when it is safe. */
function unsafeRelativePathReason(rest: string): string | null {
  if (rest.length === 0) return "has no path inside the volume";
  if (hasControlCharacter(rest)) return "contains a control character";
  if (rest.includes("\\")) return "contains a backslash";
  if (rest.startsWith("/")) return 'starts with "/"';
  for (const segment of rest.split("/")) {
    if (segment.length === 0) return "has an empty path segment";
    if (segment === "." || segment === "..") return `has a "${segment}" path segment`;
    if (segment.startsWith(RESERVED_SEGMENT_PREFIX)) {
      return `has a segment starting with "${RESERVED_SEGMENT_PREFIX}", which is reserved for the driver's own bookkeeping`;
    }
  }
  return null;
}

/** Which mount a compiled profile file belongs under, and its path inside that
 *  mount. Throws on anything that is not "hermes/…", "workspace/…" or
 *  "scratch/…", or whose remainder could leave that mount, alias another path
 *  or reach the driver's reserved paths: empty/"."/".." segments, a leading
 *  "/", a backslash, a control character, or any segment starting with
 *  ".myrmidon". This function is the enforcement boundary for what reaches the
 *  Docker API (see the module comment above), so it does not trust
 *  compileHermesProfile (G2) to have sanitized its own output first. */
export function resolveProfileFileTarget(file: Pick<CompiledProfileFile, "path">): {
  mount: BotVolumeMount;
  relativePath: string;
} {
  const slash = file.path.indexOf("/");
  const prefix = slash === -1 ? file.path : file.path.slice(0, slash);
  const rest = slash === -1 ? "" : file.path.slice(slash + 1);
  const mount = BOT_VOLUME_MOUNTS.find((candidate) => candidate.hostSuffix === prefix);
  if (!mount) {
    throw new BotContainerTemplateError(
      `profile file path ${JSON.stringify(file.path)} must start with "hermes/", "workspace/" or "scratch/"`,
    );
  }
  const reason = unsafeRelativePathReason(rest);
  if (reason) {
    throw new BotContainerTemplateError(`profile file path ${JSON.stringify(file.path)} ${reason}`);
  }
  return { mount, relativePath: rest };
}
