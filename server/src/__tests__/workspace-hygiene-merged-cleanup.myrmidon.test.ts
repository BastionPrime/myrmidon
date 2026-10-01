import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  createDb,
  executionWorkspaces,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issueReferenceMentions,
  issueWorkProducts,
  issues,
  projectWorkspaces,
  projects,
  workspaceRuntimeServices,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  WORKSPACE_STUCK_SIGNAL_METADATA_KEY,
} from "../myrmidon/workspace-hygiene/merged-cleanup.js";
import { executionWorkspaceService } from "../services/execution-workspaces.ts";

const execFileAsync = promisify(execFile);

// WORKSPACE-HYGIENE part B (Myrmidon 1.3). The terminal-workspace reaper must:
//   - archive a copy whose branch is already merged after the short merged
//     cooldown (default 30 minutes), not after the seven-day terminal cooldown;
//   - never archive a copy with an unpushed commit or a dirty tree, on any
//     cooldown setting;
//   - write one activity-log signal per day for a terminal copy that stays
//     undeletable past the signal threshold.
// Our tests live in their own file by convention; the vendor suite stays as is.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres workspace hygiene tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const nowMs = Date.UTC(2026, 5, 1, 12, 0, 0);

async function runGit(cwd: string, args: string[]) {
  await execFileAsync("git", ["-C", cwd, ...args], { cwd });
}

async function readGit(cwd: string, args: string[]) {
  const output = await execFileAsync("git", ["-C", cwd, ...args], { cwd });
  return output.stdout.trim() || null;
}

async function createTempRepo() {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-workspace-hygiene-"));
  await runGit(repoRoot, ["init"]);
  await runGit(repoRoot, ["config", "user.name", "Workspace Hygiene Test"]);
  await runGit(repoRoot, ["config", "user.email", "test@workspace-hygiene.local"]);
  await fs.writeFile(path.join(repoRoot, "README.md"), "# Test repo\n", "utf8");
  await runGit(repoRoot, ["add", "README.md"]);
  await runGit(repoRoot, ["commit", "-m", "Initial commit"]);
  await runGit(repoRoot, ["branch", "-M", "main"]);
  return repoRoot;
}

describeEmbeddedPostgres("workspace hygiene merged copy reaper", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const tempDirs = new Set<string>();
  const pullRequestDetailsByKey = new Map<string, {
    state: "merged" | "open" | "unknown";
    headRef: string | null;
    headSha: string | null;
  }>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-workspace-hygiene-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(workspaceRuntimeServices);
    await db.delete(activityLog);
    await db.delete(issueRecoveryActions);
    await db.delete(issueWorkProducts);
    await db.delete(issueReferenceMentions);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
    pullRequestDetailsByKey.clear();
    for (const dir of tempDirs) {
      await fs.rm(dir, { recursive: true, force: true });
    }
    tempDirs.clear();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function service(options: {
    cooldownDays?: number;
    mergedCooldownMs?: number;
    stuckSignalAfterMs?: number;
    clock?: () => number;
  } = {}) {
    return executionWorkspaceService(db, {
      resolvePullRequestDetails: async (companyId, reference) =>
        pullRequestDetailsByKey.get(`${companyId}:${reference.number}`)
        ?? { state: "unknown", headRef: null, headSha: null },
      now: () => new Date((options.clock ?? (() => nowMs))()),
      workspaceReaperCooldownDays: options.cooldownDays ?? 7,
      myrmidonWorkspaceMergedCooldownMs: options.mergedCooldownMs ?? 30 * MINUTE_MS,
      myrmidonWorkspaceStuckSignalAfterMs: options.stuckSignalAfterMs ?? DAY_MS,
    });
  }

  async function statusOf(executionWorkspaceId: string) {
    const [row] = await db
      .select({ status: executionWorkspaces.status, metadata: executionWorkspaces.metadata })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, executionWorkspaceId));
    return row ?? null;
  }

  async function signalRows(executionWorkspaceId: string) {
    return db
      .select({ id: activityLog.id, details: activityLog.details })
      .from(activityLog)
      .where(and(
        eq(activityLog.action, "execution_workspace.issue_terminal_archive_blocked"),
        eq(activityLog.entityId, executionWorkspaceId),
      ));
  }

  async function seedTerminalWorkspace(options: {
    mergedPr?: boolean;
    dirty?: boolean;
    terminalAgoMs?: number;
  } = {}) {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const sourceIssueId = randomUUID();
    const issuePrefix = `W${companyId.slice(0, 8).toUpperCase()}`;
    const identifier = `${issuePrefix}-1`;
    const repoRoot = await createTempRepo();
    const worktreePath = path.join(path.dirname(repoRoot), `paperclip-hygiene-${randomUUID()}`);
    tempDirs.add(repoRoot);
    tempDirs.add(worktreePath);
    await runGit(repoRoot, ["branch", "HYG-1-delivery"]);
    await runGit(repoRoot, ["worktree", "add", worktreePath, "HYG-1-delivery"]);
    await fs.writeFile(path.join(worktreePath, "delivered.txt"), "delivered\n", "utf8");
    await runGit(worktreePath, ["add", "delivered.txt"]);
    await runGit(worktreePath, ["commit", "-m", "Delivered change"]);
    const headSha = await readGit(worktreePath, ["rev-parse", "HEAD"]);
    const terminalAgoMs = options.terminalAgoMs ?? 45 * MINUTE_MS;
    const terminalAt = new Date(nowMs - terminalAgoMs);

    await db.insert(companies).values({
      id: companyId,
      name: "Workspace hygiene",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspace hygiene",
      status: "in_progress",
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: identifier,
      status: "active",
      cwd: worktreePath,
      providerRef: worktreePath,
      providerType: "git_worktree",
      repoUrl: "https://github.com/paperclipai/paperclip.git",
      baseRef: "main",
      branchName: "HYG-1-delivery",
      // Keep the workspace inside the sweep boundary the fixed clock freezes.
      updatedAt: new Date(nowMs - 2 * DAY_MS),
    });
    await db.insert(issues).values({
      id: sourceIssueId,
      companyId,
      projectId,
      identifier,
      title: "Delivered source issue",
      status: "done",
      priority: "medium",
      executionWorkspaceId,
      completedAt: terminalAt,
      updatedAt: terminalAt,
    });
    await db
      .update(executionWorkspaces)
      .set({ sourceIssueId })
      .where(eq(executionWorkspaces.id, executionWorkspaceId));

    if (options.mergedPr) {
      await db.insert(issueWorkProducts).values({
        companyId,
        issueId: sourceIssueId,
        executionWorkspaceId,
        type: "pull_request",
        provider: "github",
        title: "Delivered PR",
        url: "https://github.com/paperclipai/paperclip/pull/10623",
        status: "merged",
      });
      pullRequestDetailsByKey.set(`${companyId}:10623`, {
        state: "merged",
        headRef: "HYG-1-delivery",
        headSha,
      });
    }
    if (options.dirty) {
      await fs.writeFile(path.join(worktreePath, "scratch.txt"), "uncommitted\n", "utf8");
    }
    return { companyId, projectId, executionWorkspaceId, sourceIssueId, worktreePath, headSha };
  }

  it("archives a merged copy after the short merged cooldown, not the seven-day one", async () => {
    const seeded = await seedTerminalWorkspace({ mergedPr: true });

    // The issue tree became terminal 45 minutes ago. The seven-day terminal
    // cooldown is far from over, but the merged copy is already due.
    const sweep = await service({ cooldownDays: 7, mergedCooldownMs: 30 * MINUTE_MS })
      .sweepTerminalWorkspaces();

    expect(sweep).toMatchObject({ archived: 1, skippedCooldown: 0, skippedUndelivered: 0 });
    expect((await statusOf(seeded.executionWorkspaceId))?.status).toBe("archived");
  }, 30_000);

  it("keeps a merged copy inside the merged cooldown window", async () => {
    const seeded = await seedTerminalWorkspace({ mergedPr: true, terminalAgoMs: 20 * MINUTE_MS });

    const sweep = await service({ cooldownDays: 7, mergedCooldownMs: 30 * MINUTE_MS })
      .sweepTerminalWorkspaces();

    expect(sweep).toMatchObject({ archived: 0, skippedCooldown: 1 });
    expect((await statusOf(seeded.executionWorkspaceId))?.status).toBe("active");
  }, 30_000);

  it("archives within the hour when the merged cooldown is configured to one hour", async () => {
    const seeded = await seedTerminalWorkspace({ mergedPr: true, terminalAgoMs: 61 * MINUTE_MS });

    const sweep = await service({ cooldownDays: 7, mergedCooldownMs: 60 * MINUTE_MS })
      .sweepTerminalWorkspaces();

    expect(sweep).toMatchObject({ archived: 1 });
    expect((await statusOf(seeded.executionWorkspaceId))?.status).toBe("archived");
  }, 30_000);

  it("reaps a merged copy on the next sweep when the merged cooldown is zero", async () => {
    const seeded = await seedTerminalWorkspace({ mergedPr: true, terminalAgoMs: 0 });

    const sweep = await service({ cooldownDays: 7, mergedCooldownMs: 0 }).sweepTerminalWorkspaces();

    expect(sweep).toMatchObject({ archived: 1, skippedCooldown: 0 });
    expect((await statusOf(seeded.executionWorkspaceId))?.status).toBe("archived");
  }, 30_000);

  it("never archives a copy with an unpushed commit, even with every cooldown disabled", async () => {
    // No merged PR product: the branch carries a delivered commit that the base
    // branch does not have, so the delivery state is unmerged.
    const seeded = await seedTerminalWorkspace({ mergedPr: false });

    const sweep = await service({ cooldownDays: 0, mergedCooldownMs: 0, stuckSignalAfterMs: 0 })
      .sweepTerminalWorkspaces();

    expect(sweep).toMatchObject({ archived: 0, skippedUndelivered: 1 });
    const row = await statusOf(seeded.executionWorkspaceId);
    expect(row?.status).toBe("active");
  }, 30_000);

  it("never archives a copy with a dirty tree, even with every cooldown disabled", async () => {
    const seeded = await seedTerminalWorkspace({ mergedPr: true, dirty: true });

    const sweep = await service({ cooldownDays: 0, mergedCooldownMs: 0, stuckSignalAfterMs: 0 })
      .sweepTerminalWorkspaces();

    expect(sweep).toMatchObject({ archived: 0, skippedUndelivered: 1 });
    expect((await statusOf(seeded.executionWorkspaceId))?.status).toBe("active");
  }, 30_000);

  it("signals a stuck undeletable copy once and not again inside the repeat window", async () => {
    let clockMs = nowMs;
    const seeded = await seedTerminalWorkspace({ mergedPr: false, terminalAgoMs: 25 * 60 * MINUTE_MS });
    const svc = service({ cooldownDays: 0, mergedCooldownMs: 0, clock: () => clockMs });

    const first = await svc.sweepTerminalWorkspaces();
    expect(first).toMatchObject({ archived: 0, skippedUndelivered: 1 });
    const firstSignals = await signalRows(seeded.executionWorkspaceId);
    expect(firstSignals).toHaveLength(1);
    expect(firstSignals[0]?.details).toMatchObject({
      sourceIssueId: seeded.sourceIssueId,
      deliveryState: "unmerged",
      reason: "undelivered",
    });
    // The signal carries no host path.
    expect(JSON.stringify(firstSignals[0]?.details)).not.toContain(seeded.worktreePath);

    // A second sweep an hour later is inside the 24-hour repeat window.
    clockMs = nowMs + 60 * MINUTE_MS;
    await svc.sweepTerminalWorkspaces();
    expect(await signalRows(seeded.executionWorkspaceId)).toHaveLength(1);

    // Past the repeat window the reaper signals again.
    clockMs = nowMs + 25 * 60 * MINUTE_MS;
    await svc.sweepTerminalWorkspaces();
    expect(await signalRows(seeded.executionWorkspaceId)).toHaveLength(2);

    const row = await statusOf(seeded.executionWorkspaceId);
    expect(row?.status).toBe("active");
    expect(typeof (row?.metadata as Record<string, unknown> | null)?.[WORKSPACE_STUCK_SIGNAL_METADATA_KEY])
      .toBe("string");
  }, 30_000);

  it("does not signal a copy that only recently became terminal", async () => {
    const seeded = await seedTerminalWorkspace({ mergedPr: false, terminalAgoMs: 60 * MINUTE_MS });

    const sweep = await service({ cooldownDays: 0, mergedCooldownMs: 0, stuckSignalAfterMs: DAY_MS })
      .sweepTerminalWorkspaces();

    expect(sweep).toMatchObject({ skippedUndelivered: 1 });
    expect(await signalRows(seeded.executionWorkspaceId)).toHaveLength(0);
  }, 30_000);
});