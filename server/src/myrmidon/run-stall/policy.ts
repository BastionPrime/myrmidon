// Run stall policy (pure rules). No I/O and no clock reads here; callers pass
// `now`. Splitting the rules from the sweep keeps the threshold and the
// quiet-vs-stalled distinction unit-testable without a database.

/**
 * Every timestamp the board records about a run's own progress. They are the
 * only evidence a run is alive: the ticket is explicit that a run must never
 * be killed merely for running long, so nothing here is a duration.
 *
 * `processStartedAt`/`startedAt` are the fallback for a run that has recorded
 * no progress at all yet (a just-claimed run): they are the timestamps of the
 * claim itself, not of the work, so they only anchor the clock while no
 * progress exists.
 */
export interface RunProgressTimestamps {
  /** Newest stdout/stderr flush on the run row (heartbeat_runs.lastOutputAt). */
  lastOutputAt: Date | null;
  /** Newest action the board classified as useful work (lastUsefulActionAt). */
  lastUsefulActionAt: Date | null;
  /** Newest appended run event, any event type (heartbeat_run_events.createdAt). */
  lastEventAt: Date | null;
  processStartedAt: Date | null;
  startedAt: Date | null;
}

export type RunStallClassification = "stalled" | "active" | "unknown";

/**
 * The instant the silence clock counts from: the newest RECORDED progress of
 * the run. `null` when the run carries no timestamp at all, which is
 * "cannot judge" rather than "stalled" — this module never guesses.
 */
export function progressAnchorAt(run: RunProgressTimestamps): Date | null {
  const candidates = [
    run.lastOutputAt,
    run.lastUsefulActionAt,
    run.lastEventAt,
    run.processStartedAt,
    run.startedAt,
  ].filter((value): value is Date => value instanceof Date && !Number.isNaN(value.getTime()));
  if (candidates.length === 0) return null;
  return new Date(Math.max(...candidates.map((value) => value.getTime())));
}

/** Milliseconds since the run's newest recorded progress; `null` when unknown. */
export function progressSilenceMs(run: RunProgressTimestamps, now: Date): number | null {
  const anchor = progressAnchorAt(run);
  if (!anchor) return null;
  return Math.max(0, now.getTime() - anchor.getTime());
}

/**
 * A run is stalled exactly when the newest thing it ever recorded is older
 * than the threshold. A quiet-but-alive run differs from a stalled one only by
 * having recorded something more recently — output, any event, or a useful
 * action — so all three count equally here.
 */
export function classifyRunStall(input: {
  run: RunProgressTimestamps;
  now: Date;
  thresholdMs: number;
}): RunStallClassification {
  const silenceMs = progressSilenceMs(input.run, input.now);
  if (silenceMs === null) return "unknown";
  return silenceMs >= input.thresholdMs ? "stalled" : "active";
}

/**
 * Whether the issue of an interrupted run goes back to `todo`. Only a task the
 * stalled run itself was executing is moved, and only while it is
 * `in_progress`: an `in_review` task with a pending review stage, a `blocked`
 * task and a terminal one all keep the status they have — the interrupt
 * released the execution lock, which is the whole point, and rewriting a
 * review or a blocker here would destroy a path this module does not own.
 */
export function shouldReturnIssueToTodo(issue: {
  status: string;
  executionState?: unknown;
}): boolean {
  if (issue.status !== "in_progress") return false;
  return !hasLiveExecutionStage(issue.executionState);
}

/**
 * True when the issue carries an execution workflow that is not idle: a review
 * or approval stage in flight, or a monitor. Such a task is not "returned to
 * todo" — the workflow owns its next step.
 */
export function hasLiveExecutionStage(executionState: unknown): boolean {
  if (!executionState || typeof executionState !== "object") return false;
  const state = executionState as { status?: unknown; monitor?: unknown };
  if (typeof state.status === "string" && state.status !== "idle") return true;
  return state.monitor != null;
}