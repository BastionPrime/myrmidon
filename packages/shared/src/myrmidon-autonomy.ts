// myrmidon(1.6-AUTONOMY): the autonomy matrix contract — role × action class →
// allowed / approval_required / forbidden — plus the per-role regulation model
// with draft → approved revisions.
//
// This module is the shared half of the AUTONOMY-MATRIX epic: the core stores
// and enforces the matrix, the board UI edits it, and both sides read the same
// types and zod validators. It contains no I/O and no database access on
// purpose, so the resolver stays unit-testable and the UI can validate a PATCH
// payload before sending it.

import { z } from "zod";

/**
 * The action classes the matrix rules on. The list is deliberately small and
 * closed for 1.6: every class names a decision an agent can really attempt at
 * an enforcement point (the tool gateway or the board API). `other` is the
 * escape hatch for calls that were classified but match no narrow class — it
 * never widens a permission, it only gives such a call a defined row.
 */
export const AUTONOMY_ACTION_CLASSES = [
  "merge",
  "deploy",
  "spend_above_threshold",
  "external_message",
  "delete",
  "pause_wake_agents",
  "change_instructions",
  "other",
] as const;

export type AutonomyActionClass = (typeof AUTONOMY_ACTION_CLASSES)[number];

/**
 * What the matrix decides for a (role, action class) pair.
 *
 * - `allowed` — the action runs.
 * - `approval_required` — the action is held and an approval card goes to the
 *   board through the existing tool-action-request path; approving it executes
 *   the held action.
 * - `forbidden` — the action never runs, whatever the caller's instructions say.
 */
export const AUTONOMY_VERDICTS = ["allowed", "approval_required", "forbidden"] as const;

export type AutonomyVerdict = (typeof AUTONOMY_VERDICTS)[number];

/**
 * One row of the matrix. `role` is the caste key the platform already knows
 * (`agents.role`). `agentId` is the optional per-agent override: a row that
 * names one agent wins over a role row for that agent only.
 */
export interface AutonomyRule {
  role: string;
  actionClass: AutonomyActionClass;
  verdict: AutonomyVerdict;
  agentId?: string | null;
}

/**
 * The stored matrix. `version` is bumped by the server on every accepted edit
 * and is the optimistic-concurrency token: a PATCH that carries a stale
 * expected version is refused with 409 instead of silently overwriting a
 * concurrent edit. `defaults` covers an action class with no matching rule, so
 * an unknown role can never fall through to an undefined verdict.
 */
export interface AutonomyMatrix {
  version: number;
  rules: AutonomyRule[];
  defaults: Record<AutonomyActionClass, AutonomyVerdict>;
}

/** The state a regulation can be in. Only an approved regulation is delivered to a role. */
export type AutonomyRegulationStatus = "draft" | "approved";

/** One immutable snapshot of a regulation's text, kept so a prior approved revision can be re-promoted. */
export interface AutonomyRegulationRevision {
  revision: number;
  title: string;
  bodyMarkdown: string;
  status: AutonomyRegulationStatus;
  author: AutonomyActorRef;
  at: string;
}

/** Who made a change: a board user, a named agent, or the platform itself. */
export interface AutonomyActorRef {
  type: "board" | "agent" | "system";
  id: string;
}

/**
 * A per-role regulation: the human-readable rule the role is expected to follow.
 * The text is edited as a draft and becomes effective only after the board
 * approves it. The current `revision` always matches the newest entry of
 * `revisions`, so a reader never needs to join the two.
 */
export interface AutonomyRegulation {
  id: string;
  role: string;
  title: string;
  bodyMarkdown: string;
  status: AutonomyRegulationStatus;
  revision: number;
  revisions: AutonomyRegulationRevision[];
  createdAt: string;
  createdBy: AutonomyActorRef;
  updatedAt: string;
  updatedBy: AutonomyActorRef;
  /** Set when a newer approved regulation supersedes this one for the role. */
  supersededBy: string | null;
  /**
   * Pointer to the regulation page in the wiki once that store exists; null
   * while the regulation text lives in this document. Additive field: the
   * external key stays optional.
   */
  wikiPageId: string | null;
}

/** The actions the change log can report. */
export const AUTONOMY_CHANGE_ACTIONS = [
  "matrix_edit",
  "regulation_created",
  "regulation_edited",
  "regulation_approved",
  "regulation_rolled_back",
  "regulation_deleted",
] as const;

export type AutonomyChangeAction = (typeof AUTONOMY_CHANGE_ACTIONS)[number];

/** One row of the autonomy change log, shaped for the board UI without extra parsing. */
export interface AutonomyChangeLogEntry {
  id: string;
  at: string;
  actor: AutonomyActorRef;
  action: AutonomyChangeAction;
  summary: string;
  /** The matrix version a matrix edit produced; null for regulation rows. */
  matrixVersion: number | null;
  /** The regulation a row concerns; null for matrix rows. */
  regulationId: string | null;
}

/** The whole autonomy document for one company, as the API returns it. */
export interface AutonomySnapshot {
  matrix: AutonomyMatrix;
  regulations: AutonomyRegulation[];
  changeLog: AutonomyChangeLogEntry[];
}

const actionClassSchema = z.enum(AUTONOMY_ACTION_CLASSES);
const verdictSchema = z.enum(AUTONOMY_VERDICTS);
const actorRefSchema = z.object({
  type: z.enum(["board", "agent", "system"]),
  id: z.string().min(1).max(200),
});

export const autonomyActionClassSchema = actionClassSchema;
export const autonomyVerdictSchema = verdictSchema;
export const autonomyActorRefSchema = actorRefSchema;

export const autonomyRuleSchema = z.object({
  role: z.string().min(1).max(120),
  actionClass: actionClassSchema,
  verdict: verdictSchema,
  agentId: z.string().min(1).max(200).nullish(),
});

export const autonomyMatrixSchema = z.object({
  version: z.number().int().nonnegative(),
  rules: z.array(autonomyRuleSchema).max(2000),
  defaults: z.record(actionClassSchema, verdictSchema),
});

export const autonomyRegulationRevisionSchema = z.object({
  revision: z.number().int().positive(),
  title: z.string().min(1).max(300),
  bodyMarkdown: z.string().max(200000),
  status: z.enum(["draft", "approved"]),
  author: actorRefSchema,
  at: z.string().min(1),
});

export const autonomyRegulationSchema = z.object({
  id: z.string().min(1).max(200),
  role: z.string().min(1).max(120),
  title: z.string().min(1).max(300),
  bodyMarkdown: z.string().max(200000),
  status: z.enum(["draft", "approved"]),
  revision: z.number().int().positive(),
  revisions: z.array(autonomyRegulationRevisionSchema).max(500),
  createdAt: z.string().min(1),
  createdBy: actorRefSchema,
  updatedAt: z.string().min(1),
  updatedBy: actorRefSchema,
  supersededBy: z.string().min(1).max(200).nullable(),
  wikiPageId: z.string().min(1).max(200).nullable(),
});

export const autonomyChangeLogEntrySchema = z.object({
  id: z.string().min(1),
  at: z.string().min(1),
  actor: actorRefSchema,
  action: z.enum(AUTONOMY_CHANGE_ACTIONS),
  summary: z.string().max(2000),
  matrixVersion: z.number().int().nonnegative().nullable(),
  regulationId: z.string().min(1).max(200).nullable(),
});

/** The PATCH body for the matrix: the caller sends the rules and defaults it wants, plus the version it edited. */
export const autonomyMatrixPatchSchema = z.object({
  expectedVersion: z.number().int().nonnegative().optional(),
  rules: z.array(autonomyRuleSchema).max(2000),
  defaults: z.record(actionClassSchema, verdictSchema),
});

export type AutonomyMatrixPatch = z.infer<typeof autonomyMatrixPatchSchema>;

/**
 * The factory default: every cell allowed. Nothing changes for any role until
 * the board makes the first edit, which is what a safe release requires — an
 * install that ignores the screen keeps exactly today's behaviour. A
 * conservative factory preset is a deliberate follow-up, not a 1.6 default.
 */
export const AUTONOMY_SAFE_DEFAULTS: Record<AutonomyActionClass, AutonomyVerdict> = {
  merge: "allowed",
  deploy: "allowed",
  spend_above_threshold: "allowed",
  external_message: "allowed",
  delete: "allowed",
  pause_wake_agents: "allowed",
  change_instructions: "allowed",
  other: "allowed",
};

export function defaultAutonomyMatrix(): AutonomyMatrix {
  return { version: 1, rules: [], defaults: { ...AUTONOMY_SAFE_DEFAULTS } };
}

function normalizeRole(role: string): string {
  return role.trim().toLowerCase();
}

/**
 * Resolve the verdict for one agent against the matrix, by specificity
 * `agent > role > default`:
 *
 * 1. a rule naming this exact agent wins;
 * 2. otherwise the rule for the caller's role;
 * 3. otherwise the per-action-class default.
 *
 * The last step is what makes the resolver total: an unknown role, an empty
 * ruleset or an action class nobody ruled on still yields a defined verdict,
 * so no caller can end up with "no decision" and act by accident.
 *
 * The caller's raw instructions are deliberately not an input. That is the
 * point of the epic: a forbidden cell is forbidden even when the agent's
 * instructions demand the action.
 */
export function resolveAutonomy(
  agentRole: string | null | undefined,
  actionClass: AutonomyActionClass,
  matrix: AutonomyMatrix,
  agentId?: string | null,
): AutonomyVerdict {
  const role = agentRole ? normalizeRole(agentRole) : null;
  if (agentId) {
    const override = matrix.rules.find(
      (rule) => rule.agentId === agentId && rule.actionClass === actionClass,
    );
    if (override) return override.verdict;
  }
  if (role) {
    const roleRule = matrix.rules.find(
      (rule) => !rule.agentId && rule.actionClass === actionClass && normalizeRole(rule.role) === role,
    );
    if (roleRule) return roleRule.verdict;
  }
  return matrix.defaults[actionClass] ?? "forbidden";
}

/** True when the action class may run without a card. */
export function autonomyAllows(
  agentRole: string | null | undefined,
  actionClass: AutonomyActionClass,
  matrix: AutonomyMatrix,
  agentId?: string | null,
): boolean {
  return resolveAutonomy(agentRole, actionClass, matrix, agentId) === "allowed";
}

/** A regulation is deliverable to its role only once approved. */
export function approvedRegulationsForRole(
  regulations: AutonomyRegulation[],
  agentRole: string | null | undefined,
): AutonomyRegulation[] {
  if (!agentRole) return [];
  const role = normalizeRole(agentRole);
  return regulations.filter(
    (regulation) => regulation.status === "approved" && normalizeRole(regulation.role) === role,
  );
}