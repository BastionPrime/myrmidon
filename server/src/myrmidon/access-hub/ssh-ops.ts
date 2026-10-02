// myrmidon(SEC1-C): ssh-ops — the real DeployPort for authorized_keys layout
// on fleet hosts (Secrets UI part C), on top of the interface part A shipped.
//
// The server runs the system `ssh` (node:child_process execFile with argument
// arrays — never a shell string) as the admin channel: the private admin key
// value of an EXISTING board secret is written to a temporary 0600 file in the
// run scratch directory, passed to ssh through -i, and unlinked in finally.
// The key value is never logged, never returned, never put into an error.
// packages/adapter-utils/src/ssh.ts is NOT reused: it is the adapters'
// transport with different trust and lifecycle, and part C must not couple
// the board's admin channel to it.
//
// authorized_keys edits are idempotent and marker-based:
//   one deployed key line = <type> <body> myrmidon-access-<secretId> <fingerprint>
// A line belongs to this secret when its comment contains the marker
// `myrmidon-access-<secretId>` as a standalone word; everything else in the
// file is preserved. The write is atomic on the target: the new body travels
// base64-encoded (no quoting hazards), lands in a tmp file in ~/.ssh, then mv.
//
// Errors are human-readable strings without host addresses, user names, key
// values or file contents.

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { DeployPort } from "./ssh-deploy.js";

const execFileAsync = promisify(execFile);

const SSH_EXECUTABLE = "ssh";
const SSH_PORT = 22;

/** Marker every access-hub line carries (part A's contract). */
const ACCESS_HUB_MARKER = "myrmidon-access-";

/** Size limit for the authorized_keys body this module will process. */
const MAX_AUTHORIZED_KEYS_BYTES = 256 * 1024;

export interface SshOpsSettings {
  /** Total per-operation budget in ms (connect + command + read + write). */
  commandTimeoutMs: number;
}

export const DEFAULT_SSH_COMMAND_TIMEOUT_MS = 30_000;

export interface SshOpsDeps {
  env?: NodeJS.ProcessEnv;
  /** Injectable for tests: the execFile implementation. */
  execFile?: (typeof execFile | ((file: string, args: string[], opts: Record<string, unknown>) => Promise<{ stdout: string | Buffer }>));
  /** Injectable for tests: where the 0600 key file lives. */
  scratchDir?: () => string;
  /** Injectable for tests: mkdtemp of the run scratch directory. */
  mkdtemp?: (prefix: string) => Promise<string>;
}

export interface AdminKeySource {
  /** The private admin key material of the board's existing admin secret.
   * Resolved by the caller (routes) from the value storage; ssh-ops itself
   * only sees bytes here and never logs them. */
  adminKey(): Promise<string | null>;
}

/** Read MYRMIDON_ACCESS_HUB_SSH_* settings (docs/myrmidon/SETTINGS.md). */
export function readSshOpsSettings(env: NodeJS.ProcessEnv = process.env): SshOpsSettings {
  const raw = Number(env["MYRMIDON_ACCESS_HUB_SSH_TIMEOUT_MS"]);
  const commandTimeoutMs =
    Number.isFinite(raw) && raw >= 1000 ? Math.min(raw, 300_000) : DEFAULT_SSH_COMMAND_TIMEOUT_MS;
  return { commandTimeoutMs };
}

/** Which scratch directory the key file goes to. The Paperclip runtime sets
 * TMPDIR/PAPERCLIP_RUN_SCRATCH_DIR to the run directory; the fallback is the
 * OS tmpdir. */
function defaultScratchDir(env: NodeJS.ProcessEnv): string {
  return env["PAPERCLIP_RUN_SCRATCH_DIR"] || env["TMPDIR"] || env["PAPERCLIP_SCRATCH_DIR"] || tmpdir();
}

interface RunSshInput {
  adminKey: string;
  address: string;
  targetUser: string;
  command: string;
  timeoutMs: number;
}

interface SshCommandResult {
  ok: boolean;
  stdout: string;
}

function sshErrorNote(action: string, err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  const killed = (err as { killed?: unknown } | null)?.killed === true;
  if (killed || code === "ETIMEDOUT") {
    return `ssh ${action} timed out`;
  }
  const message = err instanceof Error ? err.message : String(err);
  return `ssh ${action} failed: ${message}`;
}

/** One ssh invocation with the admin key file lifecycle: create 0600 → run →
 * unlink in finally. */
async function runSshOnce(input: RunSshInput, deps: SshOpsDeps): Promise<SshCommandResult> {
  const exec = (deps.execFile ?? execFileAsync) as (
    file: string,
    args: string[],
    opts: Record<string, unknown>,
  ) => Promise<{ stdout: string | Buffer }>;
  const mkdtempFn = deps.mkdtemp ?? mkdtemp;
  const scratchDir = deps.scratchDir?.() ?? defaultScratchDir(deps.env ?? process.env);
  let dir: string | null = null;
  try {
    dir = await mkdtempFn(join(scratchDir, "access-hub-key-"));
    const keyPath = join(dir, "id");
    await writeFile(keyPath, input.adminKey, { mode: 0o600 });
    const { stdout } = await exec(
      SSH_EXECUTABLE,
      [
        "-i",
        keyPath,
        "-p",
        String(SSH_PORT),
        // First connection to a host: the operator registers the fingerprint
        // by laying the admin key out manually once; after that accept it.
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-o",
        "ConnectTimeout=10",
        "-o",
        "PasswordAuthentication=no",
        "-o",
        "PubkeyAuthentication=yes",
        "-o",
        "NumberOfPasswordPrompts=0",
        `${input.targetUser}@${input.address}`,
        input.command,
      ],
      { timeout: input.timeoutMs, maxBuffer: 1024 * 1024 },
    );
    return { ok: true, stdout: String(stdout) };
  } catch (err) {
    return { ok: false, stdout: sshErrorNote("command", err) };
  } finally {
    if (dir) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

/** Read the target user's authorized_keys (missing file = empty). */
function readCommand(): string {
  return "cat ~/.ssh/authorized_keys 2>/dev/null || true";
}

function newTmpName(): string {
  return `.authorized_keys.myrmidon.${randomUUID().slice(0, 12)}`;
}

/** Marker comment for one secret. */
export function accessHubMarker(secretId: string): string {
  return `${ACCESS_HUB_MARKER}${secretId}`;
}

/** Does this authorized_keys line carry the marker for this secret? */
function lineCarriesMarker(line: string, marker: string): boolean {
  const index = line.indexOf(marker);
  if (index === -1) return false;
  const charBefore = index === 0 ? " " : line[index - 1];
  const end = index + marker.length;
  const charAfter = end >= line.length ? " " : line[end];
  return (charBefore === " " || charBefore === "\t") && (charAfter === " " || charAfter === "\t" || charAfter === "");
}

/** The authorized_keys line for one deployed key. */
export function keyLine(publicKey: string, marker: string, fingerprint: string): string {
  const parts = publicKey.trim().split(/\s+/);
  const type = parts.length >= 1 ? parts[0] : "";
  const body = parts.length >= 2 ? parts[1] : "";
  if (!type || !body) {
    // Unparseable public key: hash the whole text into a well-formed line so
    // the deploy is still unique and revocable by marker.
    const hashed = Buffer.from(publicKey, "utf8").toString("base64");
    return `ssh-ed25519 ${hashed} ${marker} ${fingerprint}`;
  }
  // The original comment is dropped: the marker identifies the owner.
  return `${type} ${body} ${marker} ${fingerprint}`;
}

function normalizeTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

/** Idempotently set our line for (secretId, fingerprint) in the file body:
 * `next` null means already exactly present. Drifted lines for the same
 * secret (an older rotated key) are replaced, not kept. */
export function applyDeployToBody(
  body: string,
  input: { secretId: string; publicKey: string; fingerprint: string },
): { next: string | null; already: boolean } {
  const marker = accessHubMarker(input.secretId);
  const wanted = keyLine(input.publicKey, marker, input.fingerprint);
  const lines = body.length > 0 ? body.split("\n") : [];
  // Drop a trailing empty piece caused by the file's final newline.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const kept: string[] = [];
  let foundWanted = false;
  let removed = false;
  for (const line of lines) {
    if (lineCarriesMarker(line, marker)) {
      removed = true;
      if (line === wanted) foundWanted = true;
      continue;
    }
    kept.push(line);
  }
  if (foundWanted) {
    // Our exact line is already there. If it was the ONLY marker line, the
    // file is exactly as wanted (next null, idempotent no-op). A foreign
    // marker line (an older rotated key) is dropped — that is a change.
    const out = [...kept, wanted];
    const nextBody = normalizeTrailingNewline(out.join("\n"));
    return nextBody === normalizeTrailingNewline(body) ? { next: null, already: true } : { next: nextBody, already: true };
  }
  const out = [...kept, wanted];
  return { next: normalizeTrailingNewline(out.join("\n")), already: false };
}

/** Remove our lines for secretId from the body; next null = nothing matched. */
export function applyRevokeFromBody(body: string, secretId: string): { next: string | null } {
  const marker = accessHubMarker(secretId);
  const lines = body.length > 0 ? body.split("\n") : [];
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const kept = lines.filter((line) => !lineCarriesMarker(line, marker));
  if (kept.length === lines.length) return { next: null };
  return { next: normalizeTrailingNewline(kept.join("\n")) };
}

/** Build the atomic write command: the body travels base64 (immune to every
 * quoting hazard), lands in a tmp file in ~/.ssh, then replaces the file
 * with mv (same directory, one rename). */
function writeCommand(tmpName: string, body: string): string {
  const encoded = Buffer.from(body, "utf8").toString("base64");
  return [
    "set -eu",
    "mkdir -p -- ~/.ssh",
    "chmod 700 -- ~/.ssh 2>/dev/null || true",
    `tmp=~/.ssh/${tmpName}`,
    `printf %s '${encoded}' | base64 -d > "$tmp"`,
    `chmod 600 -- "$tmp"`,
    `touch ~/.ssh/authorized_keys`,
    `chmod 600 -- ~/.ssh/authorized_keys`,
    `mv -f -- "$tmp" ~/.ssh/authorized_keys`,
  ].join(" && ");
}

/** Board-only validation of the pieces that go into a command. */
function prevalidate(input: { address: string; targetUser: string; secretId: string }): string | null {
  if (!input.address || !/^[0-9a-zA-Z.\-:_]+$/.test(input.address)) return "host address";
  if (!input.targetUser || !/^[0-9a-zA-Z._-]+$/.test(input.targetUser)) return "target user";
  if (!input.secretId || !/^[0-9a-zA-Z._-]{1,64}$/.test(input.secretId)) return "secret id";
  return null;
}

/** Marker for the journal note: the host registry NAME, never the address. */
function noteHost(hostId: string): string {
  return `host ${hostId}`;
}

export function createSshDeployPort(
  keySource: AdminKeySource,
  opts: { env?: NodeJS.ProcessEnv; deps?: SshOpsDeps; settings?: SshOpsSettings } = {},
): DeployPort {
  const deps: SshOpsDeps = opts.deps ?? {};
  if (opts.env) deps.env = opts.env;
  const settings = opts.settings ?? readSshOpsSettings(opts.env ?? process.env);

  async function readBody(address: string, targetUser: string, adminKey: string): Promise<SshCommandResult> {
    return runSshOnce(
      { adminKey, address, targetUser, command: readCommand(), timeoutMs: settings.commandTimeoutMs },
      deps,
    );
  }

  async function writeBody(
    address: string,
    targetUser: string,
    adminKey: string,
    next: string,
  ): Promise<SshCommandResult> {
    return runSshOnce(
      {
        adminKey,
        address,
        targetUser,
        command: writeCommand(newTmpName(), next),
        timeoutMs: settings.commandTimeoutMs,
      },
      deps,
    );
  }

  async function loadBody(input: { address: string; targetUser: string; secretId: string }, adminKey: string | null): Promise<{ body: string } | { note: string }> {
    if (!adminKey) {
      return { note: "admin ssh key secret is not configured" };
    }
    const read = await readBody(input.address, input.targetUser, adminKey);
    if (!read.ok) {
      return { note: read.stdout };
    }
    if (read.stdout.length > MAX_AUTHORIZED_KEYS_BYTES) {
      return { note: "authorized_keys on the host is too large to process" };
    }
    return { body: read.stdout };
  }

  return {
    deploy: async (input) => {
      const bad = prevalidate(input);
      if (bad) return { outcome: "not_deployed", note: `invalid ${bad}` };
      const adminKey = await keySource.adminKey();
      const loaded = await loadBody(input, adminKey);
      if ("note" in loaded) return { outcome: "not_deployed", note: loaded.note };
      const plan = applyDeployToBody(loaded.body, input);
      if (plan.next === null) {
        return { outcome: "already_present", note: `key already present on ${noteHost(input.hostId)}` };
      }
      const written = await writeBody(input.address, input.targetUser, adminKey as string, plan.next);
      if (!written.ok) {
        return { outcome: "not_deployed", note: written.stdout };
      }
      return { outcome: "deployed", note: `key added to ${noteHost(input.hostId)}` };
    },

    revoke: async (input) => {
      const bad = prevalidate(input);
      if (bad) return { outcome: "not_deployed", note: `invalid ${bad}` };
      const adminKey = await keySource.adminKey();
      const loaded = await loadBody(input, adminKey);
      if ("note" in loaded) return { outcome: "not_deployed", note: loaded.note };
      const plan = applyRevokeFromBody(loaded.body, input.secretId);
      if (plan.next === null) {
        return { outcome: "not_deployed", note: `key was not present on ${noteHost(input.hostId)}` };
      }
      const written = await writeBody(input.address, input.targetUser, adminKey as string, plan.next);
      if (!written.ok) {
        return { outcome: "not_deployed", note: written.stdout };
      }
      return { outcome: "deployed", note: `key removed from ${noteHost(input.hostId)}` };
    },

    dryRun: async (input) => {
      const bad = prevalidate(input);
      if (bad) return { outcome: "not_deployed", note: `invalid ${bad}` };
      const adminKey = await keySource.adminKey();
      const loaded = await loadBody(input, adminKey);
      if ("note" in loaded) return { outcome: "not_deployed", note: loaded.note };
      const plan = applyDeployToBody(loaded.body, input);
      return {
        outcome: plan.next === null ? "already_present" : "dry_run",
        note:
          plan.next === null
            ? `key already present on ${noteHost(input.hostId)}`
            : `dry run: key would be added to ${noteHost(input.hostId)}`,
      };
    },
  };
}

// Exported for tests.
export const __internals = { keyLine, writeCommand, newTmpName };
