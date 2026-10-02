// myrmidon(ABOUT): build metadata for the "About Myrmidon" surface.
// The CI image build stamps the release version, commit, build date and the
// vendor base into the image environment (PAPERCLIP_BUILD_VERSION,
// PAPERCLIP_BUILD_COMMIT, MYRMIDON_BUILD_DATE, MYRMIDON_BASE_PAPERCLIP);
// deployment may pin MYRMIDON_IMAGE_DIGEST to the running digest. Everything
// is optional: a local checkout or an unstamped build falls back to what the
// running process can resolve itself, and fields it cannot resolve are
// reported as null instead of blocking the response.
import { serverVersion } from "../../version.js";
import { parseBuildCommit, readBuildCommit } from "../../build-commit.js";
import { parseBuildVersion, readBuildVersion } from "../../build-version.js";
import { PRODUCT_NAME } from "../product.js";

/** Build metadata exposed on the About surface. Null = not available. */
export interface AboutBuildInfo {
  product: string;
  version: string;
  commit: string | null;
  buildDate: string | null;
  /** Paperclip release this image was cut from, e.g. "2026.916.1". */
  basePaperclipVersion: string | null;
  /** Running image digest, when the deployment pinned it. */
  imageDigest: string | null;
  license: string;
  links: {
    repo: string;
    changelog: string;
    docs: string;
  };
}

const SEMVER_OR_DESCRIBE_RE = /^[0-9]+\.[0-9]+\.[0-9]+(\+[0-9]+\.git\.[0-9a-f]+(\.dirty)?)?$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?)?$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const VENDOR_VERSION_RE = /^[0-9]{4}\.[0-9]+\.[0-9]+$/;

function readTrimmed(env: NodeJS.ProcessEnv, name: string): string | null {
  const value = env[name]?.trim();
  return value ? value : null;
}

function parseBuildDate(value: string | null): string | null {
  if (!value || !ISO_DATE_RE.test(value)) return null;
  const time = Date.parse(value.includes("T") ? value : `${value}T00:00:00Z`);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

function parseVendorVersion(value: string | null): string | null {
  if (!value) return null;
  const stripped = value.startsWith("v") ? value.slice(1) : value;
  return VENDOR_VERSION_RE.test(stripped) ? stripped : null;
}

function parseImageDigest(value: string | null): string | null {
  if (!value) return null;
  const digest = value.includes("@") ? value.slice(value.indexOf("@") + 1) : value;
  return DIGEST_RE.test(digest) ? digest : null;
}

/** The commit the running code was built from, with the same fallbacks as /api/health. */
function resolveCommit(env: NodeJS.ProcessEnv): string | null {
  const stamped = parseBuildCommit(env.PAPERCLIP_BUILD_COMMIT);
  if (stamped) return stamped;
  return readBuildCommit();
}

/** The release version, with the same resolution chain as `serverVersion`. */
export function resolveAboutVersion(env: NodeJS.ProcessEnv): string {
  const stamped = parseBuildVersion(env.PAPERCLIP_BUILD_VERSION);
  if (stamped) return stamped;
  return serverVersion;
}

export function readAboutBuildInfo(env: NodeJS.ProcessEnv = process.env): AboutBuildInfo {
  return {
    product: PRODUCT_NAME,
    version: resolveAboutVersion(env),
    commit: resolveCommit(env),
    buildDate: parseBuildDate(readTrimmed(env, "MYRMIDON_BUILD_DATE")),
    basePaperclipVersion: parseVendorVersion(readTrimmed(env, "MYRMIDON_BASE_PAPERCLIP")),
    imageDigest: parseImageDigest(readTrimmed(env, "MYRMIDON_IMAGE_DIGEST")),
    license: "MIT",
    links: {
      repo: "https://github.com/itkadr-git/myrmidon",
      changelog: "https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/CHANGELOG.md",
      docs: "https://github.com/itkadr-git/myrmidon/tree/main/docs/myrmidon",
    },
  };
}
