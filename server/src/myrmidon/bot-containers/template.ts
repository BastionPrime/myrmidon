// server/src/myrmidon/bot-containers/template.ts
//
// Pure helpers for the docker-driver's fixed container template
// (containers-plan-senior-2026-09-28.md §1.4: "fleetd is not a Docker API proxy, it
// is a service with a fixed template"). Everything here is deterministic and does no
// I/O, so docker-driver.myrmidon.test.ts covers it directly without a Docker socket.
// This is also the enforcement boundary: a BotContainerSpec coming from an agent's
// adapterConfig (index.ts) cannot smuggle in an arbitrary image, bind mount or
// network — only what these functions accept ever reaches the Docker API.

import type { BotContainerSpec } from "./driver.js";
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

/** MYRMIDON_BOT_IMAGE_ALLOWLIST: comma-separated globs. `*` matches any run of
 *  characters other than "/", so a pattern never crosses a path segment. */
export function parseImageAllowlist(raw: string | undefined): string[] {
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

/** The fixed bind list for a bot. There is no way to add another bind: callers
 *  supply a botKey, never a path. */
export function buildBinds(volumeRoot: string, botKey: string): string[] {
  validateBotKey(botKey);
  return BOT_VOLUME_MOUNTS.map((mount) => `${volumeRoot}/${botKey}/${mount.hostSuffix}:${mount.containerPath}`);
}

/** `mount.containerPath` without its leading "/", e.g. "data/hermes". This is the
 *  path segment to use for anything addressed *inside* the container relative to
 *  its root (tar entry paths, exec script paths) — never `mount.hostSuffix`, which
 *  only names the bind's source directory under MYRMIDON_BOT_VOLUME_ROOT and does
 *  not match the mount point for "hermes" (host suffix "hermes" mounts to
 *  "/data/hermes", not "/hermes"). */
export function mountRootSegment(mount: BotVolumeMount): string {
  return mount.containerPath.replace(/^\//, "");
}

export const BOT_LABEL_KEYS = {
  bot: "myrmidon.bot",
  restartHash: "myrmidon.restart_hash",
  filesHash: "myrmidon.files_hash",
  image: "myrmidon.image",
} as const;

/** The driver's own identification labels always win over anything in
 *  `spec.labels` — a caller cannot use that field to spoof `myrmidon.bot` and hide
 *  a container from `list()`'s orphan scan. */
export function buildLabels(
  spec: Pick<BotContainerSpec, "botKey" | "image" | "labels">,
  profile: { restartHash: string; filesHash: string },
): Record<string, string> {
  return {
    ...spec.labels,
    [BOT_LABEL_KEYS.bot]: spec.botKey,
    [BOT_LABEL_KEYS.restartHash]: profile.restartHash,
    [BOT_LABEL_KEYS.filesHash]: profile.filesHash,
    [BOT_LABEL_KEYS.image]: spec.image,
  };
}

/** True when `rest` (the part of a profile file's path after its "hermes/" /
 *  "workspace/" / "scratch/" prefix) has no "." or ".." segment and no leading
 *  "/" — the only shapes that could carry it outside the staging directory it is
 *  written under once it reaches the tar entry path and the swap script's `mv`
 *  destination in docker-driver.ts. */
function isSafeRelativePath(rest: string): boolean {
  if (rest.startsWith("/")) return false;
  return rest.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

/** Which mount a compiled profile file belongs under, and its path inside that
 *  mount. Throws on anything that is not "hermes/…", "workspace/…" or "scratch/…",
 *  or whose remainder contains a "." / ".." segment — this function is the
 *  enforcement boundary for what reaches the Docker API (see the module comment
 *  above), so it does not trust compileHermesProfile (G2, a separate PR this
 *  module has no dependency on) to have sanitized its own output first. */
export function resolveProfileFileTarget(file: CompiledProfileFile): {
  mount: BotVolumeMount;
  relativePath: string;
} {
  const slash = file.path.indexOf("/");
  const prefix = slash === -1 ? file.path : file.path.slice(0, slash);
  const rest = slash === -1 ? "" : file.path.slice(slash + 1);
  const mount = BOT_VOLUME_MOUNTS.find((candidate) => candidate.hostSuffix === prefix);
  if (!mount || rest.length === 0 || !isSafeRelativePath(rest)) {
    throw new BotContainerTemplateError(
      `profile file path "${file.path}" must start with "hermes/", "workspace/" or "scratch/" and contain no "." or ".." path segment`,
    );
  }
  return { mount, relativePath: rest };
}
