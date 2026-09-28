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
// State tracking: Docker does not let a client update a container's labels after
// creation (no such endpoint exists), so `myrmidon.restart_hash`/`myrmidon.files_hash`
// are only accurate as of `ensure()`'s creation time — a later "files" class
// writeProfile (by design, no restart) would otherwise leave them stale forever,
// and the reconciler would keep re-pushing the same files every tick. To stay
// correct without labels, writeProfile also drops a small marker file
// (hermes/.myrmidon/applied.json) with the just-applied hashes, and status() reads
// it back through `docker exec cat` when the container is running, falling back to
// the (possibly stale, but only for a container status() has never seen files land
// on) labels otherwise. This is an own-judgment-call item, not from the plan
// document verbatim — see the PR description's "decisions made without the owner"
// section.

import http from "node:http";
import type { BotContainerDriver, BotContainerSpec, BotContainerState, BotContainerStatus } from "./driver.js";
import type { CompiledProfile, CompiledProfileFile } from "./types.js";
import {
  BOT_LABEL_KEYS,
  BotContainerTemplateError,
  buildBinds,
  buildLabels,
  containerNameFor,
  isImageAllowed,
  mountRootSegment,
  parseImageAllowlist,
  resolveProfileFileTarget,
  validateBotKey,
} from "./template.js";
import { buildUstarArchive, type UstarEntry } from "./ustar.js";

export const BOT_DOCKER_SOCKET_ENV = "MYRMIDON_BOT_DOCKER_SOCKET";
export const DEFAULT_BOT_DOCKER_SOCKET = "/var/run/docker.sock";
export const BOT_IMAGE_ALLOWLIST_ENV = "MYRMIDON_BOT_IMAGE_ALLOWLIST";
export const BOT_VOLUME_ROOT_ENV = "MYRMIDON_BOT_VOLUME_ROOT";
export const BOT_NETWORK_ENV = "MYRMIDON_BOT_NETWORK";
export const DEFAULT_BOT_NETWORK = "myrmidon-bots";

/** uid the image's entrypoint runs the gateway as (non-root; see G1). Profile files
 *  are written owned by this uid so the gateway process can read its own config and
 *  secrets without a root step inside the container. */
export const BOT_CONTAINER_UID = 10001;

/** Gateway HTTP port and health path inside the container, matching hermes-agent's
 *  own API server (`/opt/hermes-agent/src/gateway/platforms/api_server.py`,
 *  `_ROUTE_TABLE`: `("GET", "/health", self._handle_health)`, default port 8642). */
const BOT_GATEWAY_PORT = 8642;
const BOT_HEALTH_PATH = "/health";
const HEALTH_CHECK_TIMEOUT_MS = 2_000;
const RESTART_HEALTH_TIMEOUT_MS = 60_000;
const HEALTH_POLL_INTERVAL_MS = 1_000;
const EXEC_POLL_INTERVAL_MS = 200;
const EXEC_POLL_ATTEMPTS = 150; // ~30s

const DOCKER_API_VERSION = "v1.45";
const APPLIED_MARKER_PATH = "hermes/.myrmidon/applied.json";

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
 * template" enforcement. Never adds anything a caller passed beyond `spec`'s six
 * fields plus the profile's two hashes: no arbitrary binds, no host network, no
 * privileged mode. Throws on an image outside the allowlist or a network other than
 * the one configured for this driver.
 */
export function buildCreateContainerRequestBody(
  spec: BotContainerSpec,
  profile: { restartHash: string; filesHash: string },
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
    Labels: buildLabels(spec, profile),
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

interface DockerHttpResponse {
  status: number;
  body: Buffer;
}

function dockerRequest(
  socketPath: string,
  opts: { method: string; path: string; body?: Buffer; headers?: Record<string, string> },
): Promise<DockerHttpResponse> {
  return new Promise((resolve, reject) => {
    const headers = { ...opts.headers };
    if (opts.body) headers["Content-Length"] = String(opts.body.length);
    const req = http.request(
      { socketPath, path: `/${DOCKER_API_VERSION}${opts.path}`, method: opts.method, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
      },
    );
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

async function dockerJson<T>(
  socketPath: string,
  opts: { method: string; path: string; body?: unknown },
): Promise<T> {
  const bodyBuf = opts.body === undefined ? undefined : Buffer.from(JSON.stringify(opts.body), "utf8");
  const res = await dockerRequest(socketPath, {
    method: opts.method,
    path: opts.path,
    body: bodyBuf,
    headers: { "Content-Type": "application/json", Accept: "application/json" },
  });
  if (res.status >= 400) {
    throw new Error(`docker API ${opts.method} ${opts.path} failed: ${res.status} ${res.body.toString("utf8").slice(0, 500)}`);
  }
  if (res.body.length === 0) return undefined as T;
  return JSON.parse(res.body.toString("utf8")) as T;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface DockerInspect {
  Id: string;
  Image: string;
  Config?: { Image?: string; Labels?: Record<string, string> };
  State?: { Status?: string };
  HostConfig?: { Memory?: number; NanoCpus?: number; NetworkMode?: string };
}

function checkBotHealth(botKey: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: containerNameFor(botKey),
        port: BOT_GATEWAY_PORT,
        path: BOT_HEALTH_PATH,
        method: "GET",
        timeout: HEALTH_CHECK_TIMEOUT_MS,
      },
      (res) => {
        res.resume();
        const status = res.statusCode ?? 0;
        resolve(status >= 200 && status < 300);
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
    req.end();
  });
}

/** Constructs a working driver from the environment; throws if MYRMIDON_BOT_VOLUME_ROOT
 *  is unset (evaluated lazily — only when the caller actually needs a driver, so
 *  importing this module never fails on a host that has bot containers disabled). */
export function dockerBotContainerDriver(config: DockerDriverConfig = readDockerDriverConfig()): BotContainerDriver {
  const { socketPath } = config;

  async function inspect(botKey: string): Promise<DockerInspect | null> {
    const name = containerNameFor(botKey);
    const res = await dockerRequest(socketPath, { method: "GET", path: `/containers/${name}/json` });
    if (res.status === 404) return null;
    if (res.status >= 400) {
      throw new Error(`docker inspect ${name} failed: ${res.status} ${res.body.toString("utf8").slice(0, 300)}`);
    }
    return JSON.parse(res.body.toString("utf8")) as DockerInspect;
  }

  async function startContainer(botKey: string): Promise<void> {
    const name = containerNameFor(botKey);
    const res = await dockerRequest(socketPath, { method: "POST", path: `/containers/${name}/start` });
    if (res.status >= 400 && res.status !== 304) {
      throw new Error(`docker start ${name} failed: ${res.status} ${res.body.toString("utf8").slice(0, 300)}`);
    }
  }

  async function removeContainer(botKey: string): Promise<void> {
    const name = containerNameFor(botKey);
    const res = await dockerRequest(socketPath, { method: "DELETE", path: `/containers/${name}?force=true` });
    if (res.status >= 400 && res.status !== 404) {
      throw new Error(`docker remove ${name} failed: ${res.status} ${res.body.toString("utf8").slice(0, 300)}`);
    }
  }

  /** Detached exec: waits for it to finish by polling, returns its exit code. Used
   *  for the writeProfile staging swap, where we only need pass/fail. */
  async function execRun(botKey: string, cmd: string[]): Promise<number> {
    const name = containerNameFor(botKey);
    const created = await dockerJson<{ Id: string }>(socketPath, {
      method: "POST",
      path: `/containers/${name}/exec`,
      body: { Cmd: cmd, AttachStdout: true, AttachStderr: true, Tty: false },
    });
    const started = await dockerRequest(socketPath, {
      method: "POST",
      path: `/exec/${created.Id}/start`,
      body: Buffer.from(JSON.stringify({ Detach: true }), "utf8"),
      headers: { "Content-Type": "application/json" },
    });
    if (started.status >= 400) {
      throw new Error(`exec start in ${name} failed: ${started.status} ${started.body.toString("utf8").slice(0, 300)}`);
    }
    for (let attempt = 0; attempt < EXEC_POLL_ATTEMPTS; attempt++) {
      const info = await dockerJson<{ Running: boolean; ExitCode: number | null }>(socketPath, {
        method: "GET",
        path: `/exec/${created.Id}/json`,
      });
      if (!info.Running) return info.ExitCode ?? -1;
      await sleep(EXEC_POLL_INTERVAL_MS);
    }
    throw new Error(`exec in ${name} did not finish within ${EXEC_POLL_ATTEMPTS * EXEC_POLL_INTERVAL_MS}ms`);
  }

  /** Attached exec (Tty so the response is a plain byte stream, not multiplexed):
   *  used only to `cat` the small applied-state marker back out. Never used for
   *  anything whose output could contain a secret. */
  async function execCapture(botKey: string, cmd: string[]): Promise<{ exitCode: number; stdout: string }> {
    const name = containerNameFor(botKey);
    const created = await dockerJson<{ Id: string }>(socketPath, {
      method: "POST",
      path: `/containers/${name}/exec`,
      body: { Cmd: cmd, AttachStdout: true, AttachStderr: false, Tty: true },
    });
    const started = await dockerRequest(socketPath, {
      method: "POST",
      path: `/exec/${created.Id}/start`,
      body: Buffer.from(JSON.stringify({ Detach: false, Tty: true }), "utf8"),
      headers: { "Content-Type": "application/json" },
    });
    if (started.status >= 400) {
      throw new Error(`exec start in ${name} failed: ${started.status}`);
    }
    const info = await dockerJson<{ ExitCode: number | null }>(socketPath, { method: "GET", path: `/exec/${created.Id}/json` });
    return { exitCode: info.ExitCode ?? -1, stdout: started.body.toString("utf8") };
  }

  async function readAppliedMarker(botKey: string): Promise<{ restartHash?: string; filesHash?: string } | null> {
    try {
      const { exitCode, stdout } = await execCapture(botKey, ["cat", `/data/hermes/.myrmidon/applied.json`]);
      if (exitCode !== 0) return null;
      const parsed = JSON.parse(stdout) as { restartHash?: string; filesHash?: string };
      return parsed;
    } catch {
      return null;
    }
  }

  function stateFromInspect(info: DockerInspect): "running" | "stopped" {
    return info.State?.Status === "running" ? "running" : "stopped";
  }

  async function status(botKey: string): Promise<BotContainerStatus> {
    validateBotKey(botKey);
    const info = await inspect(botKey);
    if (!info) return { botKey, state: "missing" };
    const labels = info.Config?.Labels ?? {};
    let state: BotContainerState = stateFromInspect(info);
    let marker: { restartHash?: string; filesHash?: string } | null = null;
    if (state === "running") {
      marker = await readAppliedMarker(botKey);
      const healthy = await checkBotHealth(botKey);
      if (!healthy) state = "unhealthy";
    }
    return {
      botKey,
      state,
      image: info.Config?.Image,
      restartHash: marker?.restartHash ?? labels[BOT_LABEL_KEYS.restartHash],
      filesHash: marker?.filesHash ?? labels[BOT_LABEL_KEYS.filesHash],
    };
  }

  async function list(): Promise<BotContainerStatus[]> {
    const filters = encodeURIComponent(JSON.stringify({ label: [BOT_LABEL_KEYS.bot] }));
    const containers = await dockerJson<Array<{ Labels?: Record<string, string> }>>(socketPath, {
      method: "GET",
      path: `/containers/json?all=true&filters=${filters}`,
    });
    const botKeys = containers.map((c) => c.Labels?.[BOT_LABEL_KEYS.bot]).filter((key): key is string => !!key);
    const results: BotContainerStatus[] = [];
    for (const botKey of botKeys) results.push(await status(botKey));
    return results;
  }

  async function ensure(spec: BotContainerSpec, profile: CompiledProfile): Promise<void> {
    const name = containerNameFor(spec.botKey);
    const body = buildCreateContainerRequestBody(spec, profile, config);
    const existing = await inspect(spec.botKey);
    if (existing) {
      const drifted =
        existing.Config?.Image !== body.Image ||
        existing.HostConfig?.Memory !== body.HostConfig.Memory ||
        existing.HostConfig?.NanoCpus !== body.HostConfig.NanoCpus ||
        existing.HostConfig?.NetworkMode !== body.HostConfig.NetworkMode;
      if (!drifted) {
        if (stateFromInspect(existing) !== "running") await startContainer(spec.botKey);
        return;
      }
      await removeContainer(spec.botKey);
    }
    await dockerJson(socketPath, { method: "POST", path: `/containers/create?name=${name}`, body });
    await startContainer(spec.botKey);
  }

  async function writeProfile(botKey: string, profile: CompiledProfile): Promise<void> {
    validateBotKey(botKey);
    const marker: CompiledProfileFile = {
      path: APPLIED_MARKER_PATH,
      content: JSON.stringify({ restartHash: profile.restartHash, filesHash: profile.filesHash }),
      mode: 0o644,
      secret: false,
    };
    const roots = new Set<string>();
    const entries: UstarEntry[] = [...profile.files, marker].map((file) => {
      const { mount, relativePath } = resolveProfileFileTarget(file);
      const root = mountRootSegment(mount); // e.g. "data/hermes", not the bind's "hermes" host suffix
      roots.add(root);
      return {
        path: `${root}/.myrmidon-next/${relativePath}`,
        content: Buffer.from(file.content, "utf8"),
        mode: file.secret ? 0o600 : file.mode & 0o777,
        uid: BOT_CONTAINER_UID,
        gid: BOT_CONTAINER_UID,
      };
    });
    const archive = buildUstarArchive(entries);
    const name = containerNameFor(botKey);
    const putRes = await dockerRequest(socketPath, {
      method: "PUT",
      path: `/containers/${name}/archive?path=%2F&noOverwriteDirNonDir=false`,
      body: archive,
      headers: { "Content-Type": "application/x-tar" },
    });
    if (putRes.status >= 400) {
      throw new Error(`docker archive PUT to ${name} failed: ${putRes.status} ${putRes.body.toString("utf8").slice(0, 500)}`);
    }
    // Atomic per-file swap: staged files land under "<root>/.myrmidon-next/…" above,
    // then this loop moves each one over its final path with `mv` (atomic within a
    // filesystem). Anything already on disk that the profile does not mention
    // (sessions, caches, skills the bot wrote itself) is left untouched — this never
    // does a directory-level replace.
    const script = buildSwapScript([...roots]);
    const exitCode = await execRun(botKey, ["/bin/sh", "-c", script]);
    if (exitCode !== 0) {
      throw new Error(`profile file swap failed in ${name} (exit ${exitCode})`);
    }
  }

  async function waitForHealthy(botKey: string): Promise<void> {
    const name = containerNameFor(botKey);
    const deadline = Date.now() + RESTART_HEALTH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const current = await status(botKey);
      if (current.state === "running") return;
      if (current.state === "missing") throw new Error(`${name} disappeared while waiting for health after restart`);
      await sleep(HEALTH_POLL_INTERVAL_MS);
    }
    throw new Error(`${name} did not become healthy within ${RESTART_HEALTH_TIMEOUT_MS}ms of restart`);
  }

  async function restart(botKey: string): Promise<void> {
    const name = containerNameFor(botKey);
    const res = await dockerRequest(socketPath, { method: "POST", path: `/containers/${name}/restart?t=10` });
    if (res.status >= 400) {
      throw new Error(`docker restart ${name} failed: ${res.status} ${res.body.toString("utf8").slice(0, 300)}`);
    }
    await waitForHealthy(botKey);
  }

  async function stop(botKey: string): Promise<void> {
    const name = containerNameFor(botKey);
    const res = await dockerRequest(socketPath, { method: "POST", path: `/containers/${name}/stop?t=10` });
    if (res.status >= 400 && res.status !== 304 && res.status !== 404) {
      throw new Error(`docker stop ${name} failed: ${res.status} ${res.body.toString("utf8").slice(0, 300)}`);
    }
  }

  return { status, list, ensure, writeProfile, restart, stop };
}

/** Shell script run inside the container (via `/bin/sh -c`) to move every staged
 *  file from "<root>/.myrmidon-next/…" over its final path and clean the staging
 *  directory up. Built per writeProfile call from the mount roots actually staged. */
export function buildSwapScript(roots: readonly string[]): string {
  const lines: string[] = ["set -e"];
  for (const root of roots) {
    lines.push(
      `staging="/${root}/.myrmidon-next"`,
      `if [ -d "$staging" ]; then`,
      `  (cd "$staging" && find . -type f) | while IFS= read -r rel; do`,
      `    dest="/${root}/\${rel#./}"`,
      `    mkdir -p "$(dirname "$dest")"`,
      `    mv -f "$staging/\${rel#./}" "$dest"`,
      `  done`,
      `  rm -rf "$staging"`,
      `fi`,
    );
  }
  return lines.join("\n");
}
