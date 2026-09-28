// server/src/myrmidon/bot-containers/reconciler.ts
//
// Applies a compiled hermes profile to one bot's container. Design:
// containers-plan-senior-2026-09-28.md §2.2.
//
//   missing  -> create (volumes prepared, container NOT started) -> writeProfile
//               -> start (waits for health). The gateway never boots without its
//               profile, and a failed step leaves a stopped container whose
//               missing marker makes the next pass write the profile again.
//               An image that does not declare the bot runtime contract
//               (template.ts BOT_RUNTIME_CONTRACT_LABEL: API_SERVER_KEY from
//               hermes/.env, among others) is refused before anything exists,
//               so no pass creates a container whose gateway cannot start.
//   stopped  -> nothing can be running in it, so no maintenance window: recreate
//               if the template drifted, write the profile if it changed (or was
//               never verifiably applied), then start.
//   running / unhealthy (live) — anything that stops the gateway goes through
//               R3 (pause admission for this agent alone, wait for its running
//               work to drain, apply, resume):
//     template drift          -> recreate (+ writeProfile if changed) + start
//     restart class           -> writeProfile + restart
//     unhealthy (any class)   -> writeProfile if changed + restart
//     files class, running    -> writeProfile only, no restart, no window
//     none, running           -> nothing
//
// "Unhealthy" is Docker's own health verdict (the image's HEALTHCHECK after its
// retries), see docker-driver.ts botStateFromInspect — never one failed probe.
//
// R3 windows this reconciler did not open are left alone: if the agent is
// already under a maintenance window someone else opened (an operator, say), a
// change that needs one is deferred to a later pass instead of being applied
// inside — and then closing — that window.
//
// Errors never escape reconcileBot: every failure is caught, written to the
// injected activity sink, and returned as `{kind: "error"}` — a bad reconcile pass
// for one bot must not take the sweep in index.ts down with it.

import { classifyProfileChange, type CompiledProfile } from "./types.js";
import type { BotContainerDriver, BotContainerSpec } from "./driver.js";

export type MaintenanceWindowState = "entering" | "on" | "leaving" | "off";

export interface MaintenanceWindowView {
  state: MaintenanceWindowState;
  runningRuns: number;
}

export interface MaintenanceEnterResult extends MaintenanceWindowView {
  /** True when the window belongs to this reconciler: this very call opened it,
   *  or it is one the reconciler itself opened earlier and never got to close
   *  (same system actor). False for a window anyone else opened — the
   *  reconciler must neither apply inside it nor exit it. */
  owned: boolean;
}

/**
 * The slice of maintenance mode (R3, server/src/myrmidon/maintenance) the
 * reconciler needs, scoped to one agent. index.ts adapts the real
 * `maintenanceService` to this port; tests use a fake.
 */
export interface BotMaintenancePort {
  /** Opens an agent-scoped window, or returns the one already open for this
   *  agent (maintenanceService.enter does not replace an existing window). */
  enter(agentId: string, reason: string, drainTimeoutSec: number): Promise<MaintenanceEnterResult>;
  status(agentId: string): Promise<MaintenanceWindowView>;
  exit(agentId: string, reason: string): Promise<void>;
}

export interface BotContainerActivitySink {
  record(entry: {
    level: "info" | "error";
    agentId: string;
    botKey: string;
    message: string;
    details?: Record<string, unknown>;
  }): void | Promise<void>;
}

const noopActivitySink: BotContainerActivitySink = { record: () => {} };

export interface ReconcileBotInput {
  agentId: string;
  botKey: string;
  spec: BotContainerSpec;
  /** Produces the bot's compiled profile (compileHermesProfile, G2). The
   *  reconciler only ever needs the resulting CompiledProfile. */
  compile: () => Promise<CompiledProfile>;
  driver: BotContainerDriver;
  maintenance: BotMaintenancePort;
  activity?: BotContainerActivitySink;
  /** Seconds R3 waits for this agent's in-flight runs to drain before its own
   *  background tick starts interrupting them (see maintenance/service.ts
   *  `decideTick`/`interruptRuns`). Defaults to DEFAULT_MAINTENANCE_DRAIN_TIMEOUT_SEC. */
  maintenanceDrainTimeoutSec?: number;
  /** Test hook: replaces the real delay between drain polls. */
  sleep?: (ms: number) => Promise<void>;
}

export type ReconcileOutcome =
  | { kind: "created" }
  | { kind: "applied_files" }
  | { kind: "applied_restart" }
  | { kind: "unchanged" }
  | { kind: "deferred"; reason: string }
  | { kind: "error"; message: string };

export const DEFAULT_MAINTENANCE_DRAIN_TIMEOUT_SEC = 300;
const DRAIN_POLL_INTERVAL_MS = 2_000;
/** How much longer than the drain timeout the reconciler keeps polling before
 *  giving up: R3's own tick (already running server-wide, started by
 *  startMaintenanceMode at boot) is what actually interrupts runs past the
 *  deadline, and it only checks on its own interval — this is slack for that, not
 *  a second timeout the reconciler enforces itself. */
const DRAIN_POLL_GRACE_MS = 30_000;

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type PausedResult = { kind: "applied" } | { kind: "deferred"; reason: string };

/**
 * Runs `apply` with admission paused for `agentId` alone (R3, scope "agent"),
 * after its running work has drained. Exits the window on the way out — even
 * when `apply` or the drain wait throws — but only a window this reconciler
 * owns; a window someone else opened is neither used nor closed (deferred).
 */
async function withAgentPaused(
  params: {
    agentId: string;
    botKey: string;
    reason: string;
    maintenance: BotMaintenancePort;
    drainTimeoutSec: number;
    sleep: (ms: number) => Promise<void>;
    activity: BotContainerActivitySink;
  },
  apply: () => Promise<void>,
): Promise<PausedResult> {
  const { agentId, botKey, reason, maintenance, drainTimeoutSec, sleep, activity } = params;
  const entered = await maintenance.enter(agentId, reason, drainTimeoutSec);
  if (!entered.owned) {
    return {
      kind: "deferred",
      reason: "the agent is under a maintenance window the bot container reconciler did not open; retrying on a later pass",
    };
  }
  try {
    const drained = await waitForZeroRunning(maintenance, agentId, drainTimeoutSec, sleep);
    if (!drained) {
      throw new Error(`agent ${agentId} still had running work after the maintenance drain timeout`);
    }
    await apply();
    return { kind: "applied" };
  } finally {
    await maintenance.exit(agentId, reason).catch((err: unknown) => {
      void activity.record({
        level: "error",
        agentId,
        botKey,
        message: "failed to exit bot container maintenance window",
        details: { error: err instanceof Error ? err.message : String(err) },
      });
    });
  }
}

export async function reconcileBot(input: ReconcileBotInput): Promise<ReconcileOutcome> {
  const { agentId, botKey, spec, compile, driver, maintenance } = input;
  const activity = input.activity ?? noopActivitySink;
  const sleep = input.sleep ?? realSleep;
  const drainTimeoutSec = input.maintenanceDrainTimeoutSec ?? DEFAULT_MAINTENANCE_DRAIN_TIMEOUT_SEC;
  const info = (message: string, details?: Record<string, unknown>) =>
    activity.record({ level: "info", agentId, botKey, message, details });

  try {
    const status = await driver.status(botKey);

    if (status.state === "missing") {
      const profile = await compile();
      await driver.create(spec);
      await driver.writeProfile(botKey, profile);
      await driver.start(botKey);
      await info("bot container created and profile applied", {
        restartHash: profile.restartHash,
        filesHash: profile.filesHash,
      });
      return { kind: "created" };
    }

    const profile = await compile();
    // Side-effect free; a drift is only ever applied below, through recreate.
    const drifted = await driver.templateDrift(spec);
    // Hashes come only from the applied-state marker; none there means nothing
    // verified applied, which classifies as "restart", never "none".
    const changeClass = classifyProfileChange({ restartHash: status.restartHash, filesHash: status.filesHash }, profile);
    const hashes = { restartHash: profile.restartHash, filesHash: profile.filesHash };

    if (status.state === "stopped") {
      if (drifted) await driver.recreate(spec);
      if (changeClass !== "none") await driver.writeProfile(botKey, profile);
      await driver.start(botKey);
      await info("stopped bot container brought up", { drifted, changeClass, ...hashes });
      return { kind: "applied_restart" };
    }

    if (status.state === "running" && !drifted) {
      if (changeClass === "none") return { kind: "unchanged" };
      if (changeClass === "files") {
        await driver.writeProfile(botKey, profile);
        await info("bot container profile files applied without restart", { filesHash: profile.filesHash });
        return { kind: "applied_files" };
      }
    }

    // Live container and the gateway has to go down: template drift, a
    // restart-class change, or Docker's health check gave up on it.
    const reason = drifted
      ? `bot container template update (${botKey})`
      : status.state === "unhealthy"
        ? `bot container health recovery (${botKey})`
        : `bot container profile update (${botKey})`;
    const result = await withAgentPaused({ agentId, botKey, reason, maintenance, drainTimeoutSec, sleep, activity }, async () => {
      if (drifted) {
        await driver.recreate(spec);
        if (changeClass !== "none") await driver.writeProfile(botKey, profile);
        await driver.start(botKey);
        return;
      }
      if (changeClass !== "none") await driver.writeProfile(botKey, profile);
      await driver.restart(botKey); // resolves once the gateway reports healthy, or throws
    });
    if (result.kind === "deferred") {
      await info("bot container update deferred", { reason: result.reason, drifted, changeClass, state: status.state });
      return result;
    }
    await info(
      drifted
        ? "bot container recreated for a template change (image, resource limits or network)"
        : status.state === "unhealthy"
          ? "unhealthy bot container restarted"
          : "bot container restarted with updated profile",
      { drifted, changeClass, previousState: status.state, ...hashes },
    );
    return { kind: "applied_restart" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await activity.record({ level: "error", agentId, botKey, message: "bot container reconcile failed", details: { error: message } });
    return { kind: "error", message };
  }
}

async function waitForZeroRunning(
  maintenance: BotMaintenancePort,
  agentId: string,
  drainTimeoutSec: number,
  sleep: (ms: number) => Promise<void>,
): Promise<boolean> {
  const deadline = Date.now() + drainTimeoutSec * 1000 + DRAIN_POLL_GRACE_MS;
  while (Date.now() < deadline) {
    const view = await maintenance.status(agentId);
    if (view.runningRuns === 0) return true;
    await sleep(DRAIN_POLL_INTERVAL_MS);
  }
  const last = await maintenance.status(agentId);
  return last.runningRuns === 0;
}
