// server/src/myrmidon/bot-containers/driver.ts
//
// Backend-agnostic contract for bringing up and updating a bot's gateway container.
// The pilot implements it with a local Docker Engine client (docker-driver.ts) that
// talks to the same host the board runs on. The eventual `fleetd` service
// (containers-plan-senior-2026-09-28.md §1.4) is meant to implement this same
// interface over its own small HTTP API, so reconciler.ts does not change when that
// move happens — only which driver gets constructed in index.ts does.

import type { CompiledProfile } from "./types.js";

/** Desired shape of a bot's container. Passed to `ensure`; immutable for the life of
 *  the container (a template change forces a recreate, handled by the driver). */
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
   *  identification labels (see docker-driver.ts BOT_LABEL_KEYS) always win on
   *  conflict and cannot be overridden through this field. */
  labels?: Record<string, string>;
}

export type BotContainerState = "running" | "stopped" | "missing" | "unhealthy";

export interface BotContainerStatus {
  botKey: string;
  state: BotContainerState;
  image?: string;
  /** Last profile hashes the driver can confirm are applied on disk; absent when
   *  the container is missing or nothing has been written yet. This is what the
   *  reconciler compares against a freshly compiled profile — see
   *  classifyProfileChange in types.ts. */
  restartHash?: string;
  filesHash?: string;
}

export interface BotContainerDriver {
  status(botKey: string): Promise<BotContainerStatus>;
  /** All bots the driver currently manages (used for orphan/inventory sweeps). */
  list(): Promise<BotContainerStatus[]>;
  /**
   * Side-effect-free check: would calling `ensure(spec, profile)` right now force
   * a running (or stopped/unhealthy) container to be removed and recreated? True
   * only when a container already exists for `spec.botKey` and its live template
   * (image, resource limits, network) no longer matches `spec`. False when no
   * container exists yet (ensure would just create one — nothing to lose) or when
   * the existing one's template already matches.
   *
   * Callers MUST check this before calling `ensure` on anything other than a
   * freshly-`missing` bot, and gate a `true` result behind the same
   * maintenance-pause-and-drain flow used for a profile "restart" class change
   * (see reconciler.ts) — `ensure`'s own recreate is as disruptive to in-flight
   * work as a restart, but unlike a profile change it is not visible in
   * `BotContainerStatus`'s hashes, so the reconciler cannot detect it any other
   * way without first mutating the container.
   */
  templateDrift(spec: BotContainerSpec, profile: CompiledProfile): Promise<boolean>;
  /** Idempotent create-and-start: creates the container from `spec` when missing,
   *  starts it when stopped, and recreates it when the running container's template
   *  (image, resource limits) has drifted from `spec` — see `templateDrift`'s
   *  contract for when that recreate must be gated behind maintenance first. Sets
   *  the driver's own identification labels from `profile`'s hashes at creation
   *  time; does not write profile files itself — call `writeProfile` next. */
  ensure(spec: BotContainerSpec, profile: CompiledProfile): Promise<void>;
  /** Lays the compiled profile's files down in the bot's volumes without touching
   *  the running process. Safe to call on a running container; the reconciler uses
   *  this alone for a "files" class change (see types.ts ProfileChangeClass). */
  writeProfile(botKey: string, profile: CompiledProfile): Promise<void>;
  /** Restarts the container so the gateway picks up files already written to disk.
   *  Resolves only once the gateway reports healthy again; throws otherwise (the
   *  reconciler logs the failure and leaves the profile hashes applied-but-not-
   *  running for the next reconcile pass to retry). */
  restart(botKey: string): Promise<void>;
  stop(botKey: string): Promise<void>;
}
