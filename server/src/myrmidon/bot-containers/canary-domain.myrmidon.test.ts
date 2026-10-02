import { describe, expect, it } from "vitest";

import {
  BOT_CANARY_IMAGE_REPOSITORY,
  appendBotCanaryStep,
  assertNoActiveBotCanary,
  BotCanaryConflict,
  botCanaryReferenceProblem,
  botCanaryRollbackTargets,
  emptyBotCanaryDocument,
  isBotCanaryAbortable,
  isBotCanaryActive,
  newBotCanaryJob,
  parseBotCanaryDigest,
  parseBotCanaryDocument,
  planNextBotCanaryWave,
  retireBotCanaryJob,
  verifyBotCanaryImage,
  type BotCanaryJob,
  type BotCanaryStatus,
} from "./canary-domain.js";

// Placeholder data only: fake ids, digests and commit shas.

const GOOD = `sha256:${"b".repeat(64)}`;
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const SOURCE = "https://github.com/itkadr-git/myrmidon";
const NOW = new Date("2026-09-30T08:00:00.000Z");

describe("bot canary: reference form", () => {
  it("accepts a bare digest and a full bot image reference", () => {
    expect(botCanaryReferenceProblem(GOOD)).toBeNull();
    expect(botCanaryReferenceProblem(`${BOT_CANARY_IMAGE_REPOSITORY}@${GOOD}`)).toBeNull();
    expect(parseBotCanaryDigest(`${BOT_CANARY_IMAGE_REPOSITORY}@${GOOD}`)).toBe(GOOD);
    expect(parseBotCanaryDigest(GOOD)).toBe(GOOD);
  });

  it("refuses a tag, a foreign repository and a malformed digest the way the deploy rules do", () => {
    expect(botCanaryReferenceProblem("1.0.0")).toMatch(/digest|sha256/);
    expect(botCanaryReferenceProblem("ghcr.io/other/myrmidon-hermes@sha256:" + "b".repeat(64))).toContain("is not");
    expect(botCanaryReferenceProblem("sha256:ABC")).toContain("64 lowercase hex");
    expect(botCanaryReferenceProblem("sha256:" + "b".repeat(63))).toContain("64 lowercase hex");
    expect(botCanaryReferenceProblem("")).toContain("no image reference given");
    // the SERVER image repository is not the bot image repository
    expect(botCanaryReferenceProblem("ghcr.io/itkadr-git/myrmidon@sha256:" + "b".repeat(64))).toContain("is not");
  });
});

describe("bot canary: CI image verification", () => {
  const base = {
    reference: `${BOT_CANARY_IMAGE_REPOSITORY}@${GOOD}`,
    labels: {
      "org.opencontainers.image.revision": COMMIT,
      "org.opencontainers.image.source": SOURCE,
      "org.opencontainers.image.version": "main",
    },
    commitOnMain: () => true,
    releaseTagsAtCommit: [],
  };

  it("accepts a CI image from main", () => {
    expect(verifyBotCanaryImage(base)).toMatchObject({ ok: true, digest: GOOD, commit: COMMIT, version: "main" });
  });

  it("accepts an image whose commit carries a myr-v* tag", () => {
    expect(verifyBotCanaryImage({ ...base, commitOnMain: () => false, releaseTagsAtCommit: ["myr-v1.2.0"] })).toMatchObject({ ok: true });
  });

  it("refuses an image that is not in the registry", () => {
    const result = verifyBotCanaryImage({ ...base, labels: null });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("cannot be read from the registry");
  });

  it("refuses an image without the CI revision label", () => {
    const result = verifyBotCanaryImage({ ...base, labels: {} });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("org.opencontainers.image.revision");
  });

  it("refuses an image built by another workflow (source label)", () => {
    const result = verifyBotCanaryImage({
      ...base,
      labels: { ...base.labels, "org.opencontainers.image.source": "https://github.com/example/other" },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("org.opencontainers.image.source");
  });

  it("refuses an image whose commit is neither on main nor released", () => {
    const result = verifyBotCanaryImage({ ...base, commitOnMain: () => false, releaseTagsAtCommit: [] });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("neither on origin/main nor tagged");
  });
});

describe("bot canary: document parsing", () => {
  it("an empty or malformed document reads as empty", () => {
    expect(parseBotCanaryDocument(undefined)).toEqual(emptyBotCanaryDocument());
    expect(parseBotCanaryDocument("junk")).toEqual(emptyBotCanaryDocument());
    expect(parseBotCanaryDocument({ jobs: "nope" })).toEqual(emptyBotCanaryDocument());
  });

  it("a malformed job drops out; a good one survives a round trip", () => {
    const job = newBotCanaryJob({
      id: "rollout-a",
      companyId: "company-a",
      digest: GOOD,
      canaryBotKey: "agent-a",
      reason: "rollout",
      startedBy: { actorType: "user", actorId: "user-a" },
      now: NOW,
    });
    const doc = { version: 1, jobs: [{ id: "junk" }, job], history: [] };
    const parsed = parseBotCanaryDocument(doc);
    expect(parsed.jobs).toHaveLength(1);
    expect(parsed.jobs[0]).toEqual(job);
    expect(parsed.jobs[0].canaryBotKey).toBe("agent-a");
    expect(parsed.jobs[0].waveBotKeys).toEqual([]);
    expect(parsed.jobs[0].doneBotKeys).toEqual([]);
  });

  it("steps and lists are parsed defensively", () => {
    const job = newBotCanaryJob({
      id: "rollout-a",
      companyId: "company-a",
      digest: GOOD,
      canaryBotKey: "agent-a",
      reason: "rollout",
      startedBy: { actorType: "user", actorId: "user-a" },
      now: NOW,
    });
    const withStep = appendBotCanaryStep(job, "canary_waiting", "waiting", NOW);
    const parsed = parseBotCanaryDocument({ version: 1, jobs: [{ ...withStep, waveBotKeys: ["agent-b", 42, null], steps: [...withStep.steps, { at: "x", status: "junk" }] }], history: [] });
    // the initial "rollout created" step plus the appended one; the junk step drops out
    expect(parsed.jobs[0].steps).toHaveLength(2);
    expect(parsed.jobs[0].waveBotKeys).toEqual(["agent-b"]);
  });
});

describe("bot canary: one active rollout at a time", () => {
  const job = (status: string) => ({
    ...newBotCanaryJob({
      id: "rollout-a",
      companyId: "company-a",
      digest: GOOD,
      canaryBotKey: "agent-a",
      reason: "rollout",
      startedBy: { actorType: "user", actorId: "user-a" },
      now: NOW,
    }),
    status: status as never,
  });

  it("an empty document accepts a new rollout", () => {
    expect(() => assertNoActiveBotCanary(emptyBotCanaryDocument())).not.toThrow();
  });

  it("an active rollout refuses a second one", () => {
    const doc = { version: 1 as const, jobs: [job("canary_smoke")], history: [] };
    expect(() => assertNoActiveBotCanary(doc)).toThrow(BotCanaryConflict);
    expect(() => assertNoActiveBotCanary(doc)).toThrow(/already in progress/);
  });

  it("a terminal rollout in jobs does not block a new one", () => {
    const doc = { version: 1 as const, jobs: [job("succeeded")], history: [] };
    expect(() => assertNoActiveBotCanary(doc)).not.toThrow();
  });
});

describe("bot canary: abortability and activity", () => {
  const job = (status: string) => ({
    ...newBotCanaryJob({
      id: "rollout-a",
      companyId: "company-a",
      digest: GOOD,
      canaryBotKey: "agent-a",
      reason: "rollout",
      startedBy: { actorType: "user", actorId: "user-a" },
      now: NOW,
    }),
    status: status as never,
  });

  it("abortable before the canary switch, never after", () => {
    for (const status of ["pending", "verifying", "verified", "canary_waiting"]) {
      expect(isBotCanaryAbortable(job(status))).toBe(true);
    }
    for (const status of ["canary_running", "canary_health_wait", "canary_smoke", "wave_draining", "wave_applying"]) {
      expect(isBotCanaryAbortable(job(status))).toBe(false);
    }
  });

  it("active statuses are the non-terminal ones", () => {
    expect(isBotCanaryActive("wave_restoring" as never)).toBe(true);
    expect(isBotCanaryActive("rolling_back" as never)).toBe(true);
    expect(isBotCanaryActive("succeeded" as never)).toBe(false);
    expect(isBotCanaryActive("canary_smoke_failed" as never)).toBe(false);
    expect(isBotCanaryActive("rolled_back" as never)).toBe(false);
  });
});

describe("bot canary: automatic rollback targets (R5-C)", () => {
  const base = (status: BotCanaryStatus, extra: Partial<BotCanaryJob> = {}): BotCanaryJob => ({
    ...newBotCanaryJob({
      id: "rollout-a",
      companyId: "company-a",
      digest: GOOD,
      canaryBotKey: "agent-canary",
      reason: "rollout",
      startedBy: { actorType: "user", actorId: "user-a" },
      now: NOW,
    }),
    status,
    ...extra,
  });

  it("before the canary switch there is nothing to restore", () => {
    expect(botCanaryRollbackTargets(base("canary_waiting"))).toEqual([]);
    expect(botCanaryRollbackTargets(base("verifying", { doneBotKeys: [] }))).toEqual([]);
  });

  it("the canary that switched is a target even before doneBotKeys names it", () => {
    // A canary health failure happens BEFORE the smoke succeeds — doneBotKeys
    // is still empty, but the canary container already runs the new image.
    expect(botCanaryRollbackTargets(base("canary_health_wait"))).toEqual(["agent-canary"]);
    expect(botCanaryRollbackTargets(base("canary_smoke"))).toEqual(["agent-canary"]);
  });

  it("wave bots that were applied are targets, canary first", () => {
    expect(botCanaryRollbackTargets(base("wave_applying", { doneBotKeys: ["agent-canary", "agent-b"] }))).toEqual([
      "agent-canary",
      "agent-b",
    ]);
  });

  it("during the rollback itself the targets stay stable", () => {
    expect(
      botCanaryRollbackTargets(base("rolling_back", { doneBotKeys: ["agent-canary", "agent-b"], rolledBackBotKeys: ["agent-canary"] })),
    ).toEqual(["agent-canary", "agent-b"]);
  });
});

describe("bot canary: waves", () => {
  it("splits the remaining bots into a wave and the rest", () => {
    const remaining = ["agent-a", "agent-b", "agent-c", "agent-d", "agent-e", "agent-f"];
    expect(planNextBotCanaryWave(remaining, 4)).toEqual({
      wave: ["agent-a", "agent-b", "agent-c", "agent-d"],
      rest: ["agent-e", "agent-f"],
    });
    expect(planNextBotCanaryWave(remaining, 2)).toEqual({ wave: ["agent-a", "agent-b"], rest: ["agent-c", "agent-d", "agent-e", "agent-f"] });
  });

  it("a wave size below one yields an empty wave (never an unbounded one)", () => {
    expect(planNextBotCanaryWave(["agent-a"], 0)).toEqual({ wave: [], rest: ["agent-a"] });
    expect(planNextBotCanaryWave(["agent-a"], -3)).toEqual({ wave: [], rest: ["agent-a"] });
  });

  it("a wave larger than the remainder takes all of it", () => {
    expect(planNextBotCanaryWave(["agent-a", "agent-b"], 10)).toEqual({ wave: ["agent-a", "agent-b"], rest: [] });
  });
});

describe("bot canary: history", () => {
  it("retire moves a finished rollout into history, newest first, bounded", () => {
    let doc = emptyBotCanaryDocument();
    for (let i = 0; i < 25; i++) {
      const job = newBotCanaryJob({
        id: `rollout-${i}`,
        companyId: "company-a",
        digest: GOOD,
        canaryBotKey: "agent-a",
        reason: `rollout ${i}`,
        startedBy: { actorType: "user", actorId: "user-a" },
        now: new Date(NOW.getTime() + i * 1000),
      });
      doc = { ...doc, jobs: [job] };
      doc = retireBotCanaryJob(doc, job.id, new Date(NOW.getTime() + i * 1000 + 500));
    }
    expect(doc.jobs).toHaveLength(0);
    expect(doc.history).toHaveLength(20);
    expect(doc.history[0].id).toBe("rollout-24");
  });

  it("retiring an unknown id changes nothing", () => {
    const doc = emptyBotCanaryDocument();
    expect(retireBotCanaryJob(doc, "nope", NOW)).toBe(doc);
  });
});
