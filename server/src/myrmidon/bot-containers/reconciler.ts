// server/src/myrmidon/bot-containers/reconciler.ts
//
// Applies a compiled hermes profile to one bot's container. Design:
// containers-plan-senior-2026-09-28.md §2.2.
//
//   missing  -> ensure + writeProfile + restart (first boot needs the profile on
//               disk before the gateway can come up cleanly, so it gets one restart
//               right after `ensure` creates it)
//   files    -> writeProfile only, no restart
//   restart  -> pause admission for this agent alone (R3, scope "agent"), wait for
//               its running work to drain, writeProfile, restart, then resume
//   none     -> nothing to do
//
// Errors never escape reconcileBot: every failure is caught, written to the
// injected activity sink, and returned as `{kind: "error"}` — a bad reconcile pass
// for one bot must not take the sweep in index.ts down with it.

import { classifyProfileChange, type AppliedProfileState, type CompiledProfile } from "./types.js";
import type { BotContainerDriver, BotContainerSpec } from "./driver.js";

export type MaintenanceWindowState = "entering" | "on" | "leaving" | "off";

export interface MaintenanceWindowView {
  state: MaintenanceWindowState;
  runningRuns: number;
}

/**
 * The slice of maintenance mode (R3, server/src/myrmidon/maintenance) the
 * reconciler needs, scoped to one agent. index.ts adapts the real
 * `maintenanceService` (which does support `scope: {type: "agent"}` — verified
 * against server/src/myrmidon/maintenance/domain.ts's `windowCoversAgent`) to this
 * port; tests use a fake.
 */
export interface BotMaintenancePort {
  /** Idempotent: re-entering an already-open window for this agent just returns
   *  its current view, matching maintenanceService.enter's own semantics. */
  enter(agentId: string, reason: string, drainTimeoutSec: number): Promise<MaintenanceWindowView>;
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
  /** TODO(G2): once server/src/myrmidon/hermes-profile's `compileHermesProfile`
   *  lands, callers pass `() => compileHermesProfile(agent, project, …)` here. The
   *  reconciler only ever needs the resulting CompiledProfile — it does not build
   *  one itself, so this file does not import anything from that future module. */
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

export async function reconcileBot(input: ReconcileBotInput): Promise<ReconcileOutcome> {
  const { agentId, botKey, spec, compile, driver, maintenance } = input;
  const activity = input.activity ?? noopActivitySink;
  const sleep = input.sleep ?? realSleep;
  const drainTimeoutSec = input.maintenanceDrainTimeoutSec ?? DEFAULT_MAINTENANCE_DRAIN_TIMEOUT_SEC;

  try {
    const status = await driver.status(botKey);

    if (status.state === "missing") {
      const profile = await compile();
      await driver.ensure(spec, profile);
      await driver.writeProfile(botKey, profile);
      await driver.restart(botKey);
      await activity.record({
        level: "info",
        agentId,
        botKey,
        message: "bot container created and profile applied",
        details: { restartHash: profile.restartHash, filesHash: profile.filesHash },
      });
      return { kind: "created" };
    }

    const profile = await compile();
    const applied: AppliedProfileState = { restartHash: status.restartHash, filesHash: status.filesHash };
    const changeClass = classifyProfileChange(applied, profile);

    if (changeClass === "none") return { kind: "unchanged" };

    if (changeClass === "files") {
      await driver.writeProfile(botKey, profile);
      await activity.record({
        level: "info",
        agentId,
        botKey,
        message: "bot container profile files applied without restart",
        details: { filesHash: profile.filesHash },
      });
      return { kind: "applied_files" };
    }

    // changeClass === "restart": pause admission for this agent only, never the
    // whole instance or company.
    const reason = `bot container profile update (${botKey})`;
    let entered = false;
    try {
      await maintenance.enter(agentId, reason, drainTimeoutSec);
      entered = true;
      const drained = await waitForZeroRunning(maintenance, agentId, drainTimeoutSec, sleep);
      if (!drained) {
        throw new Error(`agent ${agentId} still had running work after the maintenance drain timeout`);
      }
      await driver.writeProfile(botKey, profile);
      await driver.restart(botKey); // resolves once the gateway reports healthy, or throws
    } finally {
      if (entered) {
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
    await activity.record({
      level: "info",
      agentId,
      botKey,
      message: "bot container restarted with updated profile",
      details: { restartHash: profile.restartHash, filesHash: profile.filesHash },
    });
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
