// packages/shared/src/myrmidon-wip-limit.ts
//
// myrmidon(1.6.1-WIP-LIMIT-A): the shared contract of the per-agent WIP limit.
//
// The board counts each agent's tasks in flight (`in_progress` + `in_review`),
// compares the sum with a limit and raises ONE signal per agent when the sum
// is over. The limit itself is per-company, per-agent and nullable:
//
//   - `perAgent[agentId]` wins over `defaultLimit` when the entry exists;
//   - an explicit `null` (in either place) means "count only, never signal"
//     for that agent — the feature still reports the number, but raises no
//     attention item and no comment;
//   - a missing `perAgent` entry falls back to `defaultLimit`, which itself
//     defaults to `null` (the whole feature counts but never signals).
//
// The lead rule is a domain constant, not a setting: an agent that has a
// direct report (someone's `reportsTo` points at it) is a lead, and a lead
// doing implementation work (a non-exempt in-flight task) is over the limit
// by definition — the implementation limit of a lead is 0, because a lead's
// role is supervision and acceptance, not delivery.
//
// The settings live in `instance_settings.general.wipLimit` (the same shape
// the swarm-claim pilot uses); the status feed is computed on the fly from
// live rows — no new tables.

import { z } from "zod";

// --- settings -------------------------------------------------------------

/** The `instance_settings.general` key this feature stores its settings under. */
export const WIP_LIMIT_SETTINGS_KEY = "wipLimit";

/** Body of `PUT .../wip-limit/settings` — the full settings object. */
export const wipLimitSettingsSchema = z
  .object({
    /** The company-wide default; null = count only, never signal. */
    defaultLimit: z.number().int().min(0).max(100).nullable(),
    /** Per-agent overrides; an explicit null means count-only for that agent. */
    perAgent: z.record(z.string().uuid(), z.number().int().min(0).max(100).nullable()).default({}),
  })
  .strict();

export type WipLimitSettings = z.infer<typeof wipLimitSettingsSchema>;

/** The settings as stored, or the implicit default (count only) when absent. */
export function normalizeWipLimitSettings(raw: unknown): WipLimitSettings {
  const parsed = wipLimitSettingsSchema.safeParse(raw);
  if (parsed.success) return { ...parsed.data, perAgent: { ...parsed.data.perAgent } };
  // A hand-edited row cannot half-apply: an unreadable object is the
  // count-only default, so the feature never signals off corrupt data.
  return { defaultLimit: null, perAgent: {} };
}

// --- resolution -------------------------------------------------------------

/**
 * The effective limit of one agent: the per-agent entry when present, else the
 * company default. `null` means "no limit" (count only).
 */
export function resolveWipLimitForAgent(
  settings: Pick<WipLimitSettings, "defaultLimit" | "perAgent">,
  agentId: string,
): number | null {
  if (Object.prototype.hasOwnProperty.call(settings.perAgent, agentId)) {
    return settings.perAgent[agentId] ?? null;
  }
  return settings.defaultLimit ?? null;
}

/** True when an agent is a lead: someone's reportsTo points at it. */
export function isWipLimitLead(
  agentId: string,
  reportsById: ReadonlyMap<string, string | null>,
): boolean {
  for (const reportsTo of reportsById.values()) {
    if (reportsTo === agentId) return true;
  }
  return false;
}

// --- status feed -------------------------------------------------------------

/** One row of `GET .../wip-limit/status` — the live per-agent WIP picture. */
export interface WipLimitAgentStatus {
  agentId: string;
  inProgress: number;
  inReview: number;
  wip: number;
  limit: number | null;
  overLimit: boolean;
  /** True when the over-limit state comes from the lead rule (limit 0). */
  leadRule: boolean;
}

/**
 * Build one agent's status row. `limit` is the resolved limit; the lead rule
 * overrides it with 0 for the implementation exemption check, but the reported
 * `limit` stays the settings value so the UI can show both facts.
 */
export function buildWipLimitAgentStatus(input: {
  agentId: string;
  inProgress: number;
  inReview: number;
  limit: number | null;
  isLead: boolean;
}): WipLimitAgentStatus {
  const wip = input.inProgress + input.inReview;
  const effectiveLimit = input.isLead ? 0 : input.limit;
  return {
    agentId: input.agentId,
    inProgress: input.inProgress,
    inReview: input.inReview,
    wip,
    limit: input.limit,
    overLimit: effectiveLimit !== null && wip > effectiveLimit,
    leadRule: input.isLead,
  };
}

/** The dedup key of a wip_limit signal comment — one per agent per window. */
export function wipLimitSignalKey(agentId: string, windowStart: Date): string {
  return `wip-limit:${agentId}:${windowStart.toISOString().slice(0, 10)}`;
}
