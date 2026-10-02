import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";

// myrmidon(H2): every change to an agent's instructions bundle is recorded as a
// revision so the bundle's history lives in the database next to the agent,
// not only in the mutable files on the server disk, and any earlier revision
// can be restored. The files array snapshots the whole bundle, the same shape
// the run request and the container profile compiler consume.
export type AgentInstructionsRevisionFile = {
  path: string;
  content: string;
};

export const agentInstructionsRevisions = pgTable(
  "agent_instructions_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    revisionNumber: integer("revision_number").notNull(),
    entryFile: text("entry_file").notNull(),
    files: jsonb("files").$type<AgentInstructionsRevisionFile[]>().notNull().default([]),
    changedFiles: jsonb("changed_files").$type<string[]>().notNull().default([]),
    source: text("source").notNull(),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    rolledBackFromRevisionId: uuid("rolled_back_from_revision_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    agentRevisionUq: uniqueIndex("agent_instructions_revisions_agent_revision_uq").on(
      table.agentId,
      table.revisionNumber,
    ),
    companyAgentCreatedIdx: index("agent_instructions_revisions_company_agent_created_idx").on(
      table.companyId,
      table.agentId,
      table.createdAt,
    ),
  }),
);
