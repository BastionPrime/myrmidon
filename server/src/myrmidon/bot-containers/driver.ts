// server/src/myrmidon/bot-containers/driver.ts
//
// Backend-agnostic contract for bringing up and updating a bot's gateway container.
// The pilot implements it with a local Docker Engine client (docker-driver.ts) that
// talks to the same host the board runs on. The eventual `fleetd` service
// (containers-plan-senior-2026-09-28.md §1.4) is meant to implement this same
// interface over its own small HTTP API, so reconciler.ts does not change when that
// move happens — only which driver gets constructed in index.ts does.
//
// Nothing here starts a container implicitly: `create` and `recreate` leave the
// container created-but-stopped, so the reconciler can lay the profile down first
// and only then `start` it. A gateway therefore never boots without its profile.

import type { CompiledProfile } from "./types.js";

/** Desired shape of a bot's container. Immutable for the life of the container:
 *  a change is a template drift (`templateDrift`), applied by `recreate`. */
export interface BotContainerSpec {
  /** [a-z0-9-], validated by the driver. Also the container's name and its DNS name
   *  on the bot network (`myrmidon-bot-<botKey>`). */
  botKey: string;
  /** Must match an entry in the driver's image allowlist. */
  image: string;
  memoryMb: number;
  cpus: number;
  pidsLimit: number;
  /** Docker network the container joins. The local driver requires this to equal
   *  its own MYRMIDON_BOT_NETWORK; a caller cannot put a bot on an arbitrary network. */
  network: string;
  /** Extra, non-authoritative labels (e.g. a project grouping). The driver's own
   *  identification labels (see template.ts BOT_LABEL_KEYS) always win on
   *  conflict and cannot be overridden through this field. */
  labels?: Record<string, string>;
}

/**
 * - `running`: the container is up and its health check (if the image has one)
 *   does not report it unhealthy.
 * - `unhealthy`: the container is up but its own health check has failed
 *   repeatedly (Docker's `State.Health.Status === "unhealthy"`, i.e. the image's
 *   HEALTHCHECK retries were exhausted — not a single failed probe).
 * - `stopped`: exists but is not running (created, exited, restarting, dead).
 *   Nothing can be executing in it.
 * - `missing`: no container under this bot's name.
 */
export type BotContainerState = "running" | "stopped" | "missing" | "unhealthy";

export interface BotContainerStatus {
  botKey: string;
  state: BotContainerState;
  image?: string;
  /** Profile hashes the driver can confirm were fully applied on disk, read
   *  from the marker the last successful `writeProfile` moved into place as its
   *  final step. Absent when the container is missing, when nothing has been
   *  written yet, or when the marker is unreadable — "nothing verified applied",
   *  which classifyProfileChange (types.ts) turns into a "restart" class change,
   *  never "none". */
  restartHash?: string;
  filesHash?: string;
}

export interface BotContainerDriver {
  /** Throws when the container runtime itself cannot be asked (socket error,
   *  unexpected API error) — never guesses a state. */
  status(botKey: string): Promise<BotContainerStatus>;
  /** All bots the driver currently manages (used for orphan/inventory sweeps). */
  list(): Promise<BotContainerStatus[]>;
  /**
   * Side-effect-free check: does the existing container's live template (image,
   * resource limits, network) no longer match `spec`? False when no container
   * exists. The reconciler applies a `true` with `recreate`, gated behind the
   * same maintenance-pause-and-drain flow as a profile "restart" class change
   * whenever the container is live.
   */
  templateDrift(spec: BotContainerSpec): Promise<boolean>;
  /** Creates the bot's container from `spec` without starting it, after
   *  preparing its volumes (created if absent, owned by the container's uid,
   *  mode 0700). Throws if the image is not present locally. */
  create(spec: BotContainerSpec): Promise<void>;
  /** Replaces a drifted container with one built from `spec`, left stopped.
   *  Checks the new image is present and creates the replacement before the old
   *  container is touched, then stops the old one gracefully (never a bare
   *  force-kill) and swaps the replacement in under the bot's name. */
  recreate(spec: BotContainerSpec): Promise<void>;
  /** Lays the compiled profile's files down in the bot's volumes. Works whether
   *  the container is running or stopped (does not exec into it); the reconciler
   *  uses this alone for a "files" class change on a running container. Files an
   *  earlier apply wrote that this profile no longer has are removed, and
   *  compiler-owned directories (template.ts BOT_MANAGED_DIRS) are replaced
   *  wholesale. The applied-state marker is moved into place last. */
  writeProfile(botKey: string, profile: CompiledProfile): Promise<void>;
  /** Starts a stopped container. Resolves once it is running and healthy;
   *  throws otherwise. */
  start(botKey: string): Promise<void>;
  /** Gracefully restarts a running container so the gateway picks up files
   *  already written to disk. Resolves once healthy again; throws otherwise. */
  restart(botKey: string): Promise<void>;
  stop(botKey: string): Promise<void>;
}
