// myrmidon(CLOUD-CONNECTOR): path handling for agent-supplied cloud paths.
//
// Agents address a folder-relative path as one string, never a provider item
// id: the connector resolves the path inside the granted root. Everything
// here is pure so the confinement rules can be tested without a network.
//
// Ported from the temporary `cloud-files` service (tools/cloud-files) so the
// board accepts exactly the paths that service accepted.

import { CloudConnectorError } from "./types.js";

const BAD_CHARS = /[\u0000-\u001f"*:<>?|\\]/;
const MAX_DEPTH = 32;
const MAX_SEGMENT = 255;

/** Normalise a path to NFC and split it into safe segments. The root itself is []. */
export function splitCloudPath(input: string | null | undefined): string[] {
  const normalized = (input ?? "").normalize("NFC").replace(/\\/g, "/");
  const parts: string[] = [];
  for (const segment of normalized.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      throw new CloudConnectorError(400, "'..' is not allowed in a path");
    }
    if (BAD_CHARS.test(segment) || segment.length > MAX_SEGMENT) {
      throw new CloudConnectorError(400, `bad character in path segment ${JSON.stringify(segment.slice(0, 40))}`);
    }
    parts.push(segment);
  }
  if (parts.length > MAX_DEPTH) {
    throw new CloudConnectorError(400, "path is too deep");
  }
  return parts;
}

/** Comparison key for names: macOS sends NFD, Windows NFC, so compare normalised. */
export function normalizeCloudName(value: string): string {
  return value.normalize("NFC").toLowerCase();
}

export function joinCloudPath(parts: readonly string[]): string {
  return parts.join("/");
}

/** True when `path` is the folder `base` or something below it. */
export function isWithinCloudFolder(base: readonly string[], path: readonly string[]): boolean {
  if (path.length < base.length) return false;
  return base.every((segment, index) => normalizeCloudName(segment) === normalizeCloudName(path[index]!));
}