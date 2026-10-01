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
  /** myrmidon(CONCURRENCY-SYNC): gateway.api_server.max_concurrent_runs the compiled
   *  config.yaml carries (the card's heartbeat.maxConcurrentRuns, normalized). The
   *  hashes above already change with it (the number is a line of config.yaml); this
   *  copy is what the applied-state marker records, so the board can show the value
   *  the gateway was actually given instead of inferring it. */
  maxConcurrentRuns?: number;
}

export interface AppliedProfileState {
  restartHash?: string;
  filesHash?: string;
  /** myrmidon(CONCURRENCY-SYNC): max_concurrent_runs of the profile this apply wrote,
   *  read back from the marker (docker-driver.ts AppliedMarker). Absent for a marker
   *  written before the field existed, for a container with no marker, and for one
   *  whose marker is unreadable — "not reported", never "unchanged". */
  maxConcurrentRuns?: number;
}

export function classifyProfileChange(applied: AppliedProfileState, next: CompiledProfile): ProfileChangeClass {
  if (applied.restartHash !== next.restartHash) return "restart";
  if (applied.filesHash !== next.filesHash) return "files";
  // myrmidon(CONCURRENCY-SYNC): a profile applied before the marker recorded the
  // limit has to be healed, and the healing must not restart a live gateway for a
  // change the gateway never noticed (config.yaml is byte-identical). So an applied
  // state that does not report the limit is a "files" class change: the reconciler
  // rewrites the (identical) files, which rewrites the marker with the number, and
  // the next pass is "none". See concurrency-sync.ts for the board-facing side.
  if (next.maxConcurrentRuns !== undefined && applied.maxConcurrentRuns === undefined) return "files";
  return "none";
}
