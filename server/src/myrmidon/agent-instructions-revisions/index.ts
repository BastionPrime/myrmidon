// server/src/myrmidon/agent-instructions-revisions/index.ts
//
// myrmidon(H2): route wiring for the instructions revision history. Kept in
// our own module (CONVENTIONS §8: minimal footprint in vendor files — app.ts
// gets one `api.use` line): the revision list and the rollback live under
// /api/agents/:id/instructions-revisions and follow the same authorization as
// the vendored instructions-bundle routes.

import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { unprocessable } from "../../errors.js";
import {
  agentInstructionsBundleMode,
  agentInstructionsService,
  logActivity,
} from "../../services/index.js";
import { loadAgentForInstructionsRead, loadAgentForInstructionsWrite } from "./guards.js";
import {
  getAgentInstructionsRevision,
  listAgentInstructionsRevisions,
  recordAgentInstructionsRevision,
  type AgentInstructionsRevisionRecord,
} from "./service.js";

export const INSTRUCTIONS_REVISION_ROLLBACK_ACTION = "agent.instructions_revision_rollback";

type RouteActor = {
  type?: string;
  userId?: string | null;
  agentId?: string | null;
  runId?: string | null;
  agentApiKeyId?: string | null;
};

/** The actor of an activity row, the same normalization getActorInfo applies:
 * the user id for board callers, the agent id for agent callers. */
function actorTypeOf(req: { actor?: RouteActor | null }): "agent" | "user" | "system" | "plugin" {
  if (req.actor?.type === "agent") return "agent";
  if (req.actor?.type === "board") return "user";
  return "system";
}

function actorIdOf(req: { actor?: RouteActor | null }): string {
  if (req.actor?.type === "agent") return req.actor.agentId ?? "unknown-agent";
  if (req.actor?.type === "board") return req.actor.userId ?? "board";
  return "system";
}

type RevisionSummary = {
  id: string;
  revisionNumber: number;
  entryFile: string;
  fileCount: number;
  changedFiles: string[];
  source: string;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  rolledBackFromRevisionId: string | null;
  createdAt: Date;
};

function revisionSummary(revision: AgentInstructionsRevisionRecord): RevisionSummary {
  return {
    id: revision.id,
    revisionNumber: revision.revisionNumber,
    entryFile: revision.entryFile,
    fileCount: revision.files.length,
    changedFiles: revision.changedFiles,
    source: revision.source,
    createdByAgentId: revision.createdByAgentId,
    createdByUserId: revision.createdByUserId,
    rolledBackFromRevisionId: revision.rolledBackFromRevisionId,
    createdAt: revision.createdAt,
  };
}

function filesMap(revision: { files: { path: string; content: string }[] }): Record<string, string> {
  return Object.fromEntries(revision.files.map((file) => [file.path, file.content]));
}

export function agentInstructionsRevisionsRoutes(db: Db): Router {
  const router = Router();
  const instructions = agentInstructionsService();

  router.get("/agents/:id/instructions-revisions", async (req, res) => {
    const agent = await loadAgentForInstructionsRead(req, res, db, req.params.id as string);
    if (!agent) return;
    const revisions = await listAgentInstructionsRevisions(db, agent);
    res.json(revisions.map(revisionSummary));
  });

  router.get("/agents/:id/instructions-revisions/:revisionId", async (req, res) => {
    const agent = await loadAgentForInstructionsRead(req, res, db, req.params.id as string);
    if (!agent) return;
    const revision = await getAgentInstructionsRevision(db, agent, req.params.revisionId as string);
    if (!revision) {
      res.status(404).json({ error: "Revision not found" });
      return;
    }
    res.json(revisionSummary(revision));
  });

  router.get("/agents/:id/instructions-revisions/:revisionId/files", async (req, res) => {
    const agent = await loadAgentForInstructionsRead(req, res, db, req.params.id as string);
    if (!agent) return;
    const revision = await getAgentInstructionsRevision(db, agent, req.params.revisionId as string);
    if (!revision) {
      res.status(404).json({ error: "Revision not found" });
      return;
    }
    res.json({
      id: revision.id,
      revisionNumber: revision.revisionNumber,
      entryFile: revision.entryFile,
      files: revision.files,
    });
  });

  router.post("/agents/:id/instructions-revisions/:revisionId/rollback", async (req, res) => {
    const agent = await loadAgentForInstructionsWrite(req, res, db, req.params.id as string);
    if (!agent) return;

    const revision = await getAgentInstructionsRevision(db, agent, req.params.revisionId as string);
    if (!revision) {
      res.status(404).json({ error: "Revision not found" });
      return;
    }
    if (revision.files.length === 0) {
      throw unprocessable("Revision snapshot has no files to restore");
    }
    if (agentInstructionsBundleMode(agent) === "external") {
      throw unprocessable(
        "Cannot roll back instructions of an external bundle; switch the agent to a managed bundle first",
      );
    }

    // myrmidon(H2): restore the whole snapshot through the vendored
    // materializer — it rewrites the managed bundle files and heals the
    // agent's adapterConfig to point at the managed root.
    const materialized = await instructions.materializeManagedBundle(agent, filesMap(revision), {
      entryFile: revision.entryFile,
      replaceExisting: true,
      clearLegacyPromptTemplate: true,
    });

    // Persist the healed adapterConfig through the agent service so the
    // managed-bundle wiring survives a restart, the same way the vendored
    // bundle-file write does.
    const { agentService } = await import("../../services/index.js");
    await agentService(db).update(agent.id, { adapterConfig: materialized.adapterConfig }, {
      recordRevision: {
        createdByAgentId: req.actor?.type === "agent" ? req.actor.agentId ?? null : null,
        createdByUserId: req.actor?.type === "board" ? req.actor.userId ?? null : null,
        source: "instructions_rollback",
      },
    });

    // The rollback itself becomes a new revision of the bundle, so the
    // history stays append-only and the restore is itself restorable.
    const rollbackRevision = await recordAgentInstructionsRevision(db, agent, {
      source: "rollback",
      files: filesMap(revision),
      entryFile: revision.entryFile,
      actor: {
        createdByAgentId: req.actor?.type === "agent" ? req.actor.agentId ?? null : null,
        createdByUserId: req.actor?.type === "board" ? req.actor.userId ?? null : null,
      },
      rolledBackFromRevisionId: revision.id,
    });

    await logActivity(db, {
      companyId: agent.companyId,
      actorType: actorTypeOf(req),
      actorId: actorIdOf(req),
      agentId: req.actor?.agentId ?? null,
      runId: req.actor?.runId ?? null,
      agentApiKeyId: req.actor?.agentApiKeyId ?? null,
      action: INSTRUCTIONS_REVISION_ROLLBACK_ACTION,
      entityType: "agent",
      entityId: agent.id,
      details: {
        revisionId: revision.id,
        revisionNumber: revision.revisionNumber,
        restoredRevisionId: rollbackRevision?.id ?? null,
        fileCount: revision.files.length,
      },
    });

    res.json({
      agentId: agent.id,
      restoredRevisionId: revision.id,
      restoredRevisionNumber: revision.revisionNumber,
      restoredFiles: revision.files.map((file) => file.path),
      newRevision: rollbackRevision ? revisionSummary(rollbackRevision) : null,
    });
  });

  return router;
}
