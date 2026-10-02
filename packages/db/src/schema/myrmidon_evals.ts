import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * myrmidon(EVALS-A): reference tasks for skill/behavior evaluation runs.
 *
 * One row is one benchmark task for one role: a neutral prompt plus a rubric
 * (JSON) the LLM judge scores answers against, plus an optional task kind
 * (`code` tasks also take a CI pass rate as an input parameter — the judge
 * never executes code itself). Company-scoped; ids and slugs stay namespaced
 * so they cannot collide with a vendor table.
 */
export const evalReferenceTasks = pgTable(
  "myrmidon_eval_reference_tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    role: text("role").notNull(),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    prompt: text("prompt").notNull(),
    kind: text("kind").notNull().default("general"),
    rubric: jsonb("rubric").notNull(),
    weight: integer("weight").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("myrmidon_eval_reference_tasks_company_idx").on(table.companyId),
    companyRoleSlugUq: uniqueIndex("myrmidon_eval_reference_tasks_company_role_slug_uq").on(
      table.companyId,
      table.role,
      table.slug,
    ),
  }),
);

/**
 * myrmidon(EVALS-A): one judge run over the reference set for one subject.
 *
 * `subject` is the free-form candidate identifier the caller names (a skill
 * version, an agent config, a draft). `scores` is the per-task judge output
 * and aggregate; `verdict` is the promote decision. `confirmRunId` points at
 * the second (confirmation) run when a first run crossed the regression
 * threshold. Company-scoped, namespaced table name.
 */
export const evalRuns = pgTable(
  "myrmidon_eval_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    role: text("role").notNull(),
    subject: text("subject").notNull(),
    baselineId: uuid("baseline_id"),
    confirmRunId: uuid("confirm_run_id"),
    kind: text("kind").notNull().default("first"),
    status: text("status").notNull().default("running"),
    scores: jsonb("scores"),
    verdict: text("verdict"),
    verdictReason: text("verdict_reason"),
    thresholdDrop: integer("threshold_drop"),
    confirmed: boolean("confirmed").notNull().default(false),
    model: text("model"),
    ciPassRate: integer("ci_pass_rate"),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => ({
    companyIdx: index("myrmidon_eval_runs_company_idx").on(table.companyId),
    companyRoleStartedIdx: index("myrmidon_eval_runs_company_role_started_idx").on(
      table.companyId,
      table.role,
      table.startedAt,
    ),
    baselineIdx: index("myrmidon_eval_runs_baseline_idx").on(table.baselineId),
  }),
);
