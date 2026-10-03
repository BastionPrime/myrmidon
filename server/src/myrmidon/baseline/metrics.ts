// server/src/myrmidon/baseline/metrics.ts
//
// myrmidon(1.6-BASELINE): the pure metric math.
//
// Everything here is a pure function over already-loaded rows: the status
// transitions of the completed tasks, their runs, their cost rows, the current
// blocker relations and the roles of their assignees. Keeping the math free of
// the database is what lets one test cover all six metrics with seeded
// transitions, and what lets the SQL spot-check recompute the same numbers by
// hand (scripts/myrmidon/baseline-spot-check.sql).
//
// Metric definitions (also recorded in the PR):
//  - A task is "completed in the window" when its completedAt falls inside
//    [from, to]. Every group is built from those tasks only.
//  - cycle time = completedAt - the earliest transition into todo/in_progress,
//    falling back to createdAt when a task never recorded such a transition.
//  - review time = the sum of the task's in_review status segments, clipped to
//    the window; an open segment ends at `to`.
//  - return rate = tasks with an in_review -> in_progress transition over tasks
//    that entered in_review.
//  - blocked time = the sum of the task's blocked status segments, clipped to
//    the window. Each blocked segment's time is attributed to every current
//    blocker of the task (issue_relations type=blocks).
//  - runs per task = heartbeat runs whose contextSnapshot.issueId is the task
//    and whose start falls in the window.
//  - cost per task = cost cents of the task's cost rows inside the window.
// Means use the number of completed tasks as the denominator.

export interface BaselineWindow {
  from: Date;
  to: Date;
}

export interface BaselineTaskRow {
  id: string;
  projectId: string | null;
  assigneeAgentId: string | null;
  createdAt: Date;
  completedAt: Date;
}

export interface BaselineTransitionRow {
  issueId: string;
  at: Date;
  from: string | null;
  to: string;
}

export interface BaselineRunRow {
  issueId: string;
  at: Date;
}

export interface BaselineCostRow {
  issueId: string;
  cents: number;
  at: Date;
}

export interface BaselineBlockerRow {
  issueId: string;
  blockerIssueId: string;
}

export interface BaselineAgentRoleRow {
  agentId: string;
  role: string;
}

export interface BaselineMetricsInput {
  tasks: BaselineTaskRow[];
  transitions: BaselineTransitionRow[];
  runs: BaselineRunRow[];
  costs: BaselineCostRow[];
  blockers: BaselineBlockerRow[];
  roles: BaselineAgentRoleRow[];
}

export interface BaselineHoursSummary {
  mean: number;
  median: number;
}

export interface BaselineCycleSummary {
  mean: number;
  median: number;
  p90: number;
}

export interface BaselineReturnRate {
  enteredReview: number;
  returned: number;
  rate: number;
}

export interface BaselineBlockedCause {
  cause: string;
  hours: number;
}

export interface BaselineBlockedSummary {
  total: number;
  mean: number;
  topCauses: BaselineBlockedCause[];
}

export interface BaselineRunsSummary {
  total: number;
  mean: number;
}

export interface BaselineCostSummary {
  totalCents: number;
  meanCents: number;
}

export interface BaselineGroupMetrics {
  key: string | null;
  tasksCompleted: number;
  cycleTimeHours: BaselineCycleSummary;
  timeInReviewHours: BaselineHoursSummary;
  returnRate: BaselineReturnRate;
  blockedHours: BaselineBlockedSummary;
  runsPerTask: BaselineRunsSummary;
  costPerTask: BaselineCostSummary;
}

export interface BaselineMetrics {
  byProject: BaselineGroupMetrics[];
  byRole: BaselineGroupMetrics[];
}

/** Statuses that mean "work has started" for the cycle-time start. */
const CYCLE_START_STATUSES = new Set(["todo", "in_progress"]);

const TOP_CAUSES_LIMIT = 5;

const UNASSIGNED_ROLE = "unassigned";

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function hoursBetween(start: Date, end: Date): number {
  return (end.getTime() - start.getTime()) / 3_600_000;
}

function inWindow(at: Date, window: BaselineWindow): boolean {
  return at.getTime() >= window.from.getTime() && at.getTime() <= window.to.getTime();
}

/**
 * Linear-interpolation percentile, matching PostgreSQL
 * `percentile_cont(p) WITHIN GROUP (ORDER BY x)` so the hand SQL reproduces
 * the same numbers. Returns 0 for an empty list.
 */
export function percentileCont(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = p * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  const lowValue = sorted[low]!;
  const highValue = sorted[high]!;
  if (low === high) return lowValue;
  return lowValue + (highValue - lowValue) * (rank - low);
}

interface BaselineSegment {
  status: string;
  start: Date;
  end: Date | null;
}

/** Rebuilds the status segments of one task from its ordered transitions. */
export function statusSegments(transitions: BaselineTransitionRow[]): BaselineSegment[] {
  const ordered = [...transitions].sort((a, b) => a.at.getTime() - b.at.getTime());
  const segments: BaselineSegment[] = [];
  let open: { status: string; start: Date } | null = null;
  for (const transition of ordered) {
    if (open && transition.at.getTime() > open.start.getTime()) {
      segments.push({ status: open.status, start: open.start, end: transition.at });
    }
    open = { status: transition.to, start: transition.at };
  }
  if (open) segments.push({ status: open.status, start: open.start, end: null });
  return segments;
}

/** Hours of a segment that fall inside the window; an open segment ends at `to`. */
export function clippedSegmentHours(segment: BaselineSegment, window: BaselineWindow): number {
  const start = segment.start.getTime() > window.from.getTime() ? segment.start : window.from;
  const rawEnd = segment.end ?? window.to;
  const end = rawEnd.getTime() < window.to.getTime() ? rawEnd : window.to;
  if (end.getTime() <= start.getTime()) return 0;
  return (end.getTime() - start.getTime()) / 3_600_000;
}

function cycleStartFor(task: BaselineTaskRow, transitions: BaselineTransitionRow[]): Date {
  let earliest: Date | null = null;
  for (const transition of transitions) {
    if (!CYCLE_START_STATUSES.has(transition.to)) continue;
    if (transition.from !== null && transition.from === transition.to) continue;
    if (!earliest || transition.at.getTime() < earliest.getTime()) earliest = transition.at;
  }
  return earliest ?? task.createdAt;
}

interface TaskMetrics {
  taskId: string;
  projectKey: string | null;
  roleKey: string;
  cycleHours: number;
  reviewHours: number;
  enteredReview: boolean;
  returned: boolean;
  blockedHours: number;
  blockedCauses: Map<string, number>;
  runs: number;
  costCents: number;
}

function computeTaskMetrics(
  task: BaselineTaskRow,
  transitions: BaselineTransitionRow[],
  input: BaselineMetricsInput,
  window: BaselineWindow,
  blockersByTask: Map<string, string[]>,
  roleByAgent: Map<string, string>,
): TaskMetrics {
  const segments = statusSegments(transitions);

  const cycleStart = cycleStartFor(task, transitions);
  const cycleHours = Math.max(0, hoursBetween(cycleStart, task.completedAt));

  let reviewHours = 0;
  let blockedHours = 0;
  const blockedCauses = new Map<string, number>();
  for (const segment of segments) {
    if (segment.status === "in_review") {
      reviewHours += clippedSegmentHours(segment, window);
    } else if (segment.status === "blocked") {
      const hours = clippedSegmentHours(segment, window);
      blockedHours += hours;
      if (hours > 0) {
        for (const blocker of blockersByTask.get(task.id) ?? []) {
          blockedCauses.set(blocker, (blockedCauses.get(blocker) ?? 0) + hours);
        }
      }
    }
  }

  const enteredReview = transitions.some((t) => t.to === "in_review" && t.from !== "in_review");
  const returned = transitions.some((t) => t.from === "in_review" && t.to === "in_progress");

  let runs = 0;
  for (const run of input.runs) {
    if (run.issueId === task.id && inWindow(run.at, window)) runs += 1;
  }

  let costCents = 0;
  for (const cost of input.costs) {
    if (cost.issueId === task.id && inWindow(cost.at, window)) costCents += cost.cents;
  }

  const role = task.assigneeAgentId ? roleByAgent.get(task.assigneeAgentId) : undefined;

  return {
    taskId: task.id,
    projectKey: task.projectId,
    roleKey: role ?? UNASSIGNED_ROLE,
    cycleHours,
    reviewHours,
    enteredReview,
    returned,
    blockedHours,
    blockedCauses,
    runs,
    costCents,
  };
}

function aggregateGroup(key: string | null, tasks: TaskMetrics[]): BaselineGroupMetrics {
  const count = tasks.length;
  const cycles = tasks.map((t) => t.cycleHours);
  const reviews = tasks.map((t) => t.reviewHours);
  const blockedTotal = tasks.reduce((sum, t) => sum + t.blockedHours, 0);
  const runsTotal = tasks.reduce((sum, t) => sum + t.runs, 0);
  const costTotal = tasks.reduce((sum, t) => sum + t.costCents, 0);

  const causeHours = new Map<string, number>();
  for (const task of tasks) {
    for (const [cause, hours] of task.blockedCauses) {
      causeHours.set(cause, (causeHours.get(cause) ?? 0) + hours);
    }
  }
  const topCauses = [...causeHours.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, TOP_CAUSES_LIMIT)
    .map(([cause, hours]) => ({ cause, hours: round2(hours) }));

  const enteredReview = tasks.filter((t) => t.enteredReview).length;
  const returned = tasks.filter((t) => t.returned).length;

  return {
    key,
    tasksCompleted: count,
    cycleTimeHours: {
      mean: round2(cycles.reduce((sum, value) => sum + value, 0) / count),
      median: round2(percentileCont(cycles, 0.5)),
      p90: round2(percentileCont(cycles, 0.9)),
    },
    timeInReviewHours: {
      mean: round2(reviews.reduce((sum, value) => sum + value, 0) / count),
      median: round2(percentileCont(reviews, 0.5)),
    },
    returnRate: {
      enteredReview,
      returned,
      rate: enteredReview === 0 ? 0 : round4(returned / enteredReview),
    },
    blockedHours: {
      total: round2(blockedTotal),
      mean: round2(blockedTotal / count),
      topCauses,
    },
    runsPerTask: {
      total: runsTotal,
      mean: round2(runsTotal / count),
    },
    costPerTask: {
      totalCents: costTotal,
      meanCents: round2(costTotal / count),
    },
  };
}

function groupTasks(tasks: TaskMetrics[], keyOf: (task: TaskMetrics) => string | null): BaselineGroupMetrics[] {
  const groups = new Map<string, TaskMetrics[]>();
  for (const task of tasks) {
    const key = keyOf(task);
    const mapKey = key === null ? "\u0000null" : key;
    const bucket = groups.get(mapKey);
    if (bucket) bucket.push(task);
    else groups.set(mapKey, [task]);
  }
  return [...groups.entries()]
    .map(([mapKey, bucket]) => aggregateGroup(mapKey === "\u0000null" ? null : mapKey, bucket))
    .sort((a, b) => (a.key ?? "").localeCompare(b.key ?? ""));
}

/** Computes both breakdowns over the tasks completed inside the window. */
export function computeBaselineMetrics(input: BaselineMetricsInput, window: BaselineWindow): BaselineMetrics {
  const transitionsByIssue = new Map<string, BaselineTransitionRow[]>();
  for (const transition of input.transitions) {
    if (transition.from !== null && transition.from === transition.to) continue;
    const bucket = transitionsByIssue.get(transition.issueId);
    if (bucket) bucket.push(transition);
    else transitionsByIssue.set(transition.issueId, [transition]);
  }

  const blockersByTask = new Map<string, string[]>();
  for (const blocker of input.blockers) {
    const bucket = blockersByTask.get(blocker.issueId);
    if (bucket) bucket.push(blocker.blockerIssueId);
    else blockersByTask.set(blocker.issueId, [blocker.blockerIssueId]);
  }

  const roleByAgent = new Map(input.roles.map((row) => [row.agentId, row.role]));

  // The query already narrows to the window; filtering here too keeps the
  // math self-consistent and lets one seeded input cover both sides of the
  // boundary.
  const completed = input.tasks.filter(
    (task) =>
      task.completedAt.getTime() >= window.from.getTime() &&
      task.completedAt.getTime() <= window.to.getTime(),
  );

  const perTask = completed.map((task) =>
    computeTaskMetrics(
      task,
      transitionsByIssue.get(task.id) ?? [],
      input,
      window,
      blockersByTask,
      roleByAgent,
    ),
  );

  return {
    byProject: groupTasks(perTask, (task) => task.projectKey),
    byRole: groupTasks(perTask, (task) => task.roleKey),
  };
}