// server/src/myrmidon/bot-containers/types.ts
// Shared contract between the hermes profile compiler and the bot container reconciler.

export type ProfileChangeClass = "none" | "files" | "restart";

export interface CompiledProfileFile {
  /** Path relative to the bot volume root, e.g. "hermes/config.yaml", "workspace/AGENTS.md". */
  path: string;
  content: string;
  /** POSIX mode, e.g. 0o600 for secrets, 0o644 otherwise. */
  mode: number;
  /** True when the file holds secret values and must never be logged. */
  secret: boolean;
}

export interface CompiledProfile {
  botKey: string;
  files: CompiledProfileFile[];
  /** Hash over files that need a gateway restart to apply (config.yaml, .env, hindsight config, skill files — the gateway's skills index is cached in-process and does not watch the skills dir). */
  restartHash: string;
  /** Hash over files a running gateway picks up without restart (AGENTS.md). */
  filesHash: string;
}

export interface AppliedProfileState {
  restartHash?: string;
  filesHash?: string;
}

export function classifyProfileChange(applied: AppliedProfileState, next: CompiledProfile): ProfileChangeClass {
  if (applied.restartHash !== next.restartHash) return "restart";
  if (applied.filesHash !== next.filesHash) return "files";
  return "none";
}
