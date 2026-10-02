// myrmidon(1.6-CTO-CHAT-B): the wire contract of the CTO chat planner.
//
// One owner message in free text becomes a proposed epic with child tasks.
// This module is the single point both halves of the feature import: the
// server module that generates the proposal and the chat screen that renders
// it. It carries no behaviour beyond validation and the mapping into the
// board's existing `suggest_tasks` card payload, so the card type, the task
// creation path and the approval semantics stay the vendor's.
//
// Shape. The planner answers one proposal:
//
//   { planId, epic, tasks[] }
//
// `epic` is the task that becomes the parent issue; each entry of `tasks` is a
// child of it. `acceptanceCriteria` is a separate array (not folded into the
// description) because the card screen renders the criteria line by line. The
// card itself is the board's existing interaction kind: `toSuggestTasksPayload`
// turns a proposal into its `tasks[]`, where the epic is the entry with no
// `parentClientKey` and every child points at the epic's `clientKey`.
//
// The `planId` is an opaque handle minted by the planner. It is not an
// identifier of any stored row — nothing about a proposal is persisted.
import { z } from "zod";

import { ISSUE_PRIORITIES, type IssuePriority } from "./constants.js";

/** Upper bounds, chosen to fit one card screen and the vendor's card limits. */
export const CTO_CHAT_MAX_TASKS = 20;
export const CTO_CHAT_MAX_ACCEPTANCE_CRITERIA = 12;

/**
 * Acceptance criteria of one task: a short non-empty list of one-line items.
 * Empty is allowed on purpose — an epic does not always have criteria of its
 * own, while a child task without any is a weak proposal, not an invalid one.
 */
export const ctoChatAcceptanceCriteriaSchema = z
  .array(
    z
      .string()
      .trim()
      .min(1)
      .max(500),
  )
  .max(CTO_CHAT_MAX_ACCEPTANCE_CRITERIA);

/** One proposed task: the epic itself, or a child of it. */
export const ctoChatPlannedTaskSchema = z.object({
  /** Stable within one proposal; the card payload uses it as `clientKey`. */
  clientKey: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .regex(/^[a-z0-9][a-z0-9_-]*$/),
  title: z.string().trim().min(1).max(240),
  description: z.string().trim().max(20_000).nullable().optional(),
  acceptanceCriteria: ctoChatAcceptanceCriteriaSchema.optional(),
  priority: z.enum(ISSUE_PRIORITIES).nullable().optional(),
});

/** The epic a proposal builds: the parent issue of every planned task. */
export const ctoChatPlannedEpicSchema = z.object({
  title: z.string().trim().min(1).max(240),
  description: z.string().trim().max(20_000).nullable().optional(),
  acceptanceCriteria: ctoChatAcceptanceCriteriaSchema.optional(),
});

/**
 * One proposal from the planner. The epic's `clientKey` is kept next to it so
 * the card payload can name the parent of every child without inventing one.
 */
export const ctoChatPlanSchema = z
  .object({
    planId: z.string().trim().min(1).max(120),
    epic: ctoChatPlannedEpicSchema,
    epicClientKey: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .regex(/^[a-z0-9][a-z0-9_-]*$/),
    tasks: z.array(ctoChatPlannedTaskSchema).min(1).max(CTO_CHAT_MAX_TASKS),
  })
  .superRefine((value, ctx) => {
    const seen = new Set<string>([value.epicClientKey]);
    for (const [index, task] of value.tasks.entries()) {
      if (seen.has(task.clientKey)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "clientKey must be unique within one proposal",
          path: ["tasks", index, "clientKey"],
        });
        continue;
      }
      seen.add(task.clientKey);
    }
  });

export type CtoChatPlannedTask = z.infer<typeof ctoChatPlannedTaskSchema>;
export type CtoChatPlannedEpic = z.infer<typeof ctoChatPlannedEpicSchema>;
export type CtoChatPlan = z.infer<typeof ctoChatPlanSchema>;

/** Where the owner's message came from. */
export const CTO_CHAT_SOURCES = ["portal", "telegram"] as const;
export type CtoChatSource = (typeof CTO_CHAT_SOURCES)[number];

/** Body of the planner route and the planner service call. */
export const ctoChatPlanRequestSchema = z.object({
  text: z.string().trim().min(1).max(20_000),
  source: z.enum(CTO_CHAT_SOURCES).optional(),
});
export type CtoChatPlanRequest = z.infer<typeof ctoChatPlanRequestSchema>;

/** The planner's answer: the route returns it as `{ proposal }`. */
export const ctoChatPlanResponseSchema = z.object({
  proposal: ctoChatPlanSchema,
});
export type CtoChatPlanResponse = z.infer<typeof ctoChatPlanResponseSchema>;

/** A card entry, as the vendor's `suggest_tasks` payload describes one. */
export interface CtoChatSuggestedTaskDraft {
  clientKey: string;
  parentClientKey: string | null;
  title: string;
  description: string;
  priority: IssuePriority | null;
}

/** The vendor card payload this proposal maps onto. */
export interface CtoChatSuggestTasksPayload {
  version: 1;
  tasks: CtoChatSuggestedTaskDraft[];
}

/**
 * Render criteria and description into the one `description` field the card
 * carries. Criteria are listed under a heading so the card keeps them visible;
 * a task with neither keeps an empty description rather than a lone heading.
 */
export function composeTaskDescription(input: {
  description?: string | null;
  acceptanceCriteria?: readonly string[];
}): string {
  const description = (input.description ?? "").trim();
  const criteria = (input.acceptanceCriteria ?? [])
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (criteria.length === 0) return description;
  const block = ["Acceptance criteria:", ...criteria.map((item) => `- ${item}`)].join("\n");
  return description.length === 0 ? block : `${description}\n\n${block}`;
}

/**
 * Map a proposal onto the board's existing `suggest_tasks` card payload: the
 * epic first with no parent, every child pointing at the epic's client key.
 * Nothing is created here — the vendor's acceptance path does that.
 */
export function toSuggestTasksPayload(plan: CtoChatPlan): CtoChatSuggestTasksPayload {
  const parsed = ctoChatPlanSchema.parse(plan);
  return {
    version: 1,
    tasks: [
      {
        clientKey: parsed.epicClientKey,
        parentClientKey: null,
        title: parsed.epic.title,
        description: composeTaskDescription({
          description: parsed.epic.description,
          acceptanceCriteria: parsed.epic.acceptanceCriteria,
        }),
        priority: null,
      },
      ...parsed.tasks.map((task) => ({
        clientKey: task.clientKey,
        parentClientKey: parsed.epicClientKey,
        title: task.title,
        description: composeTaskDescription({
          description: task.description,
          acceptanceCriteria: task.acceptanceCriteria,
        }),
        priority: task.priority ?? null,
      })),
    ],
  };
}

/**
 * Validate a plan before any card is created: the vendor's own card schema
 * rejects a payload with duplicate client keys, and a card that cannot be
 * accepted is worse than no card. The epic key is checked against the children
 * here rather than left to the card, because the mapping collapses a child's
 * parent onto the epic key and two equal keys would silently create one task.
 */
export function assertCtoChatPlanAcceptable(plan: CtoChatPlan): CtoChatPlan {
  const parsed = ctoChatPlanSchema.parse(plan);
  const payload = toSuggestTasksPayload(parsed);
  const keys = new Set<string>();
  for (const task of payload.tasks) {
    if (keys.has(task.clientKey)) {
      throw new Error(`Duplicate client key in proposal: ${task.clientKey}`);
    }
    keys.add(task.clientKey);
  }
  const epic = payload.tasks[0];
  if (!epic || epic.parentClientKey !== null) {
    throw new Error("Proposal must start with the epic task");
  }
  return parsed;
}