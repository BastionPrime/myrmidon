// myrmidon(R5-B) bot image canary: the service lifecycle over fake ports.
//
// Pins the acceptance criteria of the rollout:
//  - a non-CI image is refused before the canary is touched;
//  - the canary is ONE bot, and a failed canary (health or smoke) stops the
//    rollout with the other containers untouched (applyNow calls after the
//    canary: zero);
//  - waves only run after the canary smoke succeeded, in waveSize chunks;
//  - the rollout drives the same applyBotContainerNow the sweep uses, with the
//    pinned image in the card's place.

import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { emptyBotCanaryDocument, type BotCanaryDocument } from "./canary-domain.js";
import { botCanaryService, type BotCanaryRuntimePort, type BotCanaryServiceDeps } from "./canary-service.js";
import { readBotCanarySettings, type BotCanarySettings } from "./canary-settings.js";
import type { BotCanaryProbeDeps } from "./canary-registry.js";
import type { ApplyBotContainerOutcome, BotContainerAgent } from "./index.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const CANARY = "agent-canary";
const GOOD = `sha256:${"b".repeat(64)}`;
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const VERSION = "main";
const CI_LABELS = {
  "org.opencontainers.image.revision": COMMIT,
  "org.opencontainers.image.source": "https://github.com/itkadr-git/myrmidon",
  "org.opencontainers.image.version": VERSION,
};

const SETTINGS: BotCanarySettings = {
  ...readBotCanarySettings({}),
  enabled: true,
  canaryBotKey: CANARY,
  waveSize: 2,
  healthSettleMs: 0,
  smokeTimeoutMs: 1_000,
  stepTimeoutMs: 60_000,
};

function agent(agentId: string): BotContainerAgent {
  return {
    agentId,
    adapterType: "hermes_gateway",
    adapterConfig: {
      container: { enabled: true, image: "myrmidon-hermes:old", memoryMb: 512, cpus: 1, pidsLimit: 128 },
    },
  };
}

/** In-memory document store standing in for the instance_settings row. */
class MemoryStore {
  doc: BotCanaryDocument = emptyBotCanaryDocument();

  read = async () => structuredClone(this.doc);
  mutate = async <T>(change: (current: BotCanaryDocument) => { next: BotCanaryDocument | null; result: T }) => {
    const { next, result } = change(this.doc);
    if (next) this.doc = next;
    return { doc: this.doc, result, changed: next !== null };
  };
}

interface Harness {
  service: ReturnType<typeof botCanaryService>;
  store: MemoryStore;
  runtime: {
    listAgents: ReturnType<typeof vi.fn>;
    applyNow: ReturnType<typeof vi.fn>;
    status: ReturnType<typeof vi.fn>;
    canaryApiKey: ReturnType<typeof vi.fn>;
  };
  smoke: ReturnType<typeof vi.fn>;
  setHealth(value: string): void;
  appliedImages: string[];
}

function harness(options: {
  labels?: Record<string, string> | null;
  onMain?: boolean;
  enabled?: boolean;
  agents?: string[];
  health?: string;
  smokeOk?: boolean;
  applyOutcome?: "ok" | "error" | "deferred";
} = {}): Harness {
  const store = new MemoryStore();
  const appliedImages: string[] = [];
  const agents = (options.agents ?? [CANARY, "agent-b", "agent-c", "agent-d"]).map(agent);
  let health = options.health ?? "running";
  const smokeOk = options.smokeOk ?? true;

  const runtime: BotCanaryRuntimePort = {
    listAgents: vi.fn(async () => agents),
    applyNow: vi.fn(async (_agent: BotContainerAgent, image: string): Promise<ApplyBotContainerOutcome> => {
      appliedImages.push(`${_agent.agentId}:${image.slice(-19)}`);
      if (options.applyOutcome === "error") return { kind: "error", message: "recreate failed" };
      if (options.applyOutcome === "deferred") return { kind: "deferred", reason: "someone else's window" };
      return { kind: "applied_restart" };
    }),
    status: vi.fn(async () => ({ state: health })),
    canaryApiKey: vi.fn(async () => "fake-canary-key"),
  };

  const smoke = vi.fn(async (botKey: string, rolloutId: string) => {
    void botKey;
    void rolloutId;
    return smokeOk
      ? { ok: true as const, runId: "run-smoke", status: "completed" }
      : { ok: false as const, runId: "run-smoke", status: "failed", reason: "the smoke run ended in 'failed'" };
  });

  const inspectAnswer =
    options.labels === undefined || options.labels === null
      ? options.labels === null
        ? null
        : { config: { Labels: CI_LABELS } }
      : { config: { Labels: options.labels } };

  const deps: BotCanaryServiceDeps = {
    runtime,
    now: () => new Date("2026-09-30T08:00:00.000Z"),
    settings: { ...SETTINGS, enabled: options.enabled ?? true },
    probes: {
      fetchJson: async (url: string) => {
        if (url.startsWith("https://ghcr.io/token")) return { token: "fake-token" };
        if (url.includes("/manifests/")) return { config: { digest: "sha256:cfg" } };
        if (url.includes("/blobs/")) return inspectAnswer;
        if (url.includes("/compare/")) return { status: options.onMain === false ? "diverged" : "ahead" };
        if (url.includes("matching-refs")) return [];
        throw new Error(`unexpected url ${url}`);
      },
    } as BotCanaryProbeDeps,
    logActivity: (async () => ({})) as unknown as BotCanaryServiceDeps["logActivity"],
    smoke: smoke as unknown as BotCanaryServiceDeps["smoke"],
    env: { MYRMIDON_BOT_CONTAINERS: "1" },
  };

  const service = botCanaryService(store as unknown as Db, deps);
  return {
    service,
    store,
    runtime: runtime as unknown as Harness["runtime"],
    smoke: smoke as unknown as Harness["smoke"],
    setHealth(value: string) {
      health = value;
    },
    appliedImages,
  };
}

const ACTOR = { actorType: "user", actorId: "user-a" };

describe("bot canary service: creating a rollout", () => {
  it("refuses to start when the feature is not enabled", async () => {
    const h = harness({ enabled: false });
    await expect(h.service.create({ reference: GOOD }, ACTOR)).rejects.toThrow(/not enabled/);
  });

  it("refuses to start without a chosen canary bot", async () => {
    const store = new MemoryStore();
    const deps: BotCanaryServiceDeps = {
      runtime: {
        listAgents: async () => [],
        applyNow: async () => ({ kind: "error", message: "never" }),
        status: async () => ({ state: "missing" }),
        canaryApiKey: async () => null,
      },
      settings: { ...SETTINGS, canaryBotKey: null },
      logActivity: (async () => ({})) as unknown as BotCanaryServiceDeps["logActivity"],
    };
    const service = botCanaryService(store as unknown as Db, deps);
    await expect(service.create({ reference: GOOD }, ACTOR)).rejects.toThrow(/MYRMIDON_BOT_CANARY_SELECTOR/);
  });

  it("refuses a non-CI image before anything happens: no apply, no canary touch", async () => {
    const h = harness({ labels: null });
    const job = await h.service.create({ reference: GOOD }, ACTOR);
    expect(job.status).toBe("failed_verification");
    expect(job.failureReason).toContain("cannot be read from the registry");
    expect(h.runtime.applyNow).not.toHaveBeenCalled();
    const current = await h.service.current();
    expect(current.job?.status).toBe("failed_verification");
  });

  it("refuses an image whose commit is not on main and not released", async () => {
    const h = harness({ onMain: false });
    const job = await h.service.create({ reference: GOOD }, ACTOR);
    expect(job.status).toBe("failed_verification");
    expect(job.failureReason).toContain("neither on origin/main nor tagged");
  });

  it("verifies a CI image and waits for the canary", async () => {
    const h = harness();
    const job = await h.service.create({ reference: GOOD }, ACTOR);
    expect(job.status).toBe("canary_waiting");
    expect(job.version).toBe(VERSION);
    expect(job.commit).toBe(COMMIT);
    expect(job.canaryBotKey).toBe(CANARY);
    expect(h.runtime.applyNow).not.toHaveBeenCalled();
  });

  it("rejects a second rollout while one is active", async () => {
    const h = harness();
    await h.service.create({ reference: GOOD }, ACTOR);
    await expect(h.service.create({ reference: `sha256:${"c".repeat(64)}` }, ACTOR)).rejects.toThrow(/already in progress/);
  });
});

describe("bot canary service: the tick drives the canary", () => {
  it("applies the new image to the canary alone, then waits for health", async () => {
    const h = harness();
    await h.service.create({ reference: GOOD }, ACTOR);
    await h.service.tick(); // canary_waiting -> canary_running (apply)
    expect(h.runtime.applyNow).toHaveBeenCalledTimes(1);
    const applied = h.runtime.applyNow.mock.calls[0];
    expect(applied[0].agentId).toBe(CANARY);
    expect(String(applied[1])).toContain(GOOD);
    expect((await h.service.current()).job?.status).toBe("canary_running");

    await h.service.tick(); // canary_running -> canary_health_wait
    expect((await h.service.current()).job?.status).toBe("canary_health_wait");

    await h.service.tick(); // settle (healthSettleMs=0) -> canary_smoke
    expect((await h.service.current()).job?.status).toBe("canary_smoke");
  });

  it("a deferred canary apply (someone else's window) retries instead of failing", async () => {
    const h = harness({ applyOutcome: "deferred" });
    await h.service.create({ reference: GOOD }, ACTOR);
    await h.service.tick();
    const status = (await h.service.current()).job?.status;
    expect(status === "canary_waiting" || status === "canary_running").toBe(true);
    expect(h.appliedImages).toEqual([`${CANARY}:${GOOD.slice(-19)}`]);
  });

  it("a canary apply error fails the rollout and no other bot is touched", async () => {
    const h = harness({ applyOutcome: "error" });
    await h.service.create({ reference: GOOD }, ACTOR);
    await h.service.tick();
    const job = (await h.service.current()).job;
    expect(job?.status).toBe("canary_failed");
    expect(job?.failureReason).toContain("recreate failed");
    // the acceptance criterion: the other containers were not touched
    expect(h.appliedImages).toHaveLength(1);
    expect(h.appliedImages[0].startsWith(CANARY)).toBe(true);
    expect(h.smoke).not.toHaveBeenCalled();
  });

  it("an unhealthy canary before the smoke fails the rollout", async () => {
    const h = harness({ health: "unhealthy" });
    await h.service.create({ reference: GOOD }, ACTOR);
    await h.service.tick(); // apply
    await h.service.tick(); // -> health wait
    await h.service.tick(); // sees unhealthy
    const job = (await h.service.current()).job;
    expect(job?.status).toBe("canary_failed");
    expect(job?.failureReason).toContain("unhealthy");
    expect(h.smoke).not.toHaveBeenCalled();
    expect(h.appliedImages).toHaveLength(1);
  });
});

describe("bot canary service: the smoke gate", () => {
  async function driveToSmoke(h: Harness) {
    await h.service.create({ reference: GOOD }, ACTOR);
    await h.service.tick(); // apply
    await h.service.tick(); // health wait
    await h.service.tick(); // smoke
  }

  it("a successful smoke moves to waves and only then are other bots touched", async () => {
    const h = harness();
    await driveToSmoke(h);
    expect((await h.service.current()).job?.status).toBe("canary_smoke");
    // No wave bot has been applied yet — only the canary.
    expect(h.appliedImages.filter((entry) => !entry.startsWith(CANARY))).toEqual([]);

    await h.service.tick(); // smoke runs
    const job = (await h.service.current()).job;
    expect(job?.status).toBe("wave_draining");
    expect(job?.doneBotKeys).toEqual([CANARY]);
    expect(h.smoke).toHaveBeenCalledTimes(1);
  });

  it("a failed smoke stops the rollout: no wave bot is ever touched", async () => {
    const h = harness({ smokeOk: false });
    await driveToSmoke(h);
    await h.service.tick(); // smoke runs and fails
    const job = (await h.service.current()).job;
    expect(job?.status).toBe("canary_smoke_failed");
    expect(job?.failureReason).toContain("smoke run failed");
    // acceptance criterion: the other containers are left alone
    expect(h.appliedImages).toHaveLength(1);
    expect(h.appliedImages[0].startsWith(CANARY)).toBe(true);
    // and the rollout is terminal: further ticks do nothing
    await h.service.tick();
    await h.service.tick();
    expect(h.appliedImages).toHaveLength(1);
  });
});

describe("bot canary service: waves", () => {
  async function driveToWaveDraining(h: Harness) {
    await h.service.create({ reference: GOOD }, ACTOR);
    await h.service.tick(); // canary apply -> canary_running
    await h.service.tick(); // -> canary_health_wait
    await h.service.tick(); // settle -> canary_smoke
    await h.service.tick(); // smoke done -> wave_draining (wave not planned yet)
  }

  it("waves apply the remaining bots after the canary, in waveSize chunks", async () => {
    const h = harness(); // agents: canary + b + c + d, waveSize 2
    await driveToWaveDraining(h);
    // Waves are planned by the next tick: smoke success is what unlocks them.
    let job = (await h.service.current()).job;
    expect(job?.status).toBe("wave_draining");
    expect(job?.doneBotKeys).toEqual([CANARY]);
    // No wave bot has been applied yet — only the canary.
    expect(h.appliedImages.filter((entry) => !entry.startsWith(CANARY))).toEqual([]);

    await h.service.tick(); // plans wave [agent-b, agent-c] and applies agent-b
    job = (await h.service.current()).job;
    expect(job?.status).toBe("wave_applying");
    expect(job?.waveBotKeys).toEqual(["agent-b", "agent-c"]);

    await h.service.tick(); // agent-c applied
    job = (await h.service.current()).job;
    expect(job?.status).toBe("wave_applying");
    expect(job?.doneBotKeys).toEqual([CANARY, "agent-b", "agent-c"]);

    await h.service.tick(); // wave done -> wave_restoring
    job = (await h.service.current()).job;
    expect(job?.status).toBe("wave_restoring");
    expect(job?.doneBotKeys).toEqual([CANARY, "agent-b", "agent-c"]);

    await h.service.tick(); // -> wave_draining (second wave not planned yet)
    job = (await h.service.current()).job;
    expect(job?.status).toBe("wave_draining");

    await h.service.tick(); // plans wave [agent-d] and applies it
    job = (await h.service.current()).job;
    expect(job?.status).toBe("wave_applying");
    expect(job?.waveBotKeys).toEqual(["agent-d"]);

    await h.service.tick(); // -> wave_restoring
    await h.service.tick(); // no remainder -> succeeded
    job = (await h.service.current()).job;
    expect(job?.status).toBe("succeeded");
    expect(job?.doneBotKeys.sort()).toEqual([CANARY, "agent-b", "agent-c", "agent-d"].sort());
    // every bot got exactly the pinned image
    expect(h.appliedImages).toHaveLength(4);
    for (const entry of h.appliedImages) expect(entry.endsWith(GOOD.slice(-19))).toBe(true);
  });

  it("a wave bot apply error fails the rollout at that bot; later bots are untouched", async () => {
    // The canary succeeds; the wave's first bot fails.
    const store = new MemoryStore();
    const agents = [CANARY, "agent-b", "agent-c"].map(agent);
    let call = 0;
    const appliedImages: string[] = [];
    const runtime: BotCanaryRuntimePort = {
      listAgents: vi.fn(async () => agents),
      applyNow: vi.fn(async (a: BotContainerAgent, image: string): Promise<ApplyBotContainerOutcome> => {
        call++;
        appliedImages.push(`${a.agentId}:${image.slice(-19)}`);
        if (call >= 2) return { kind: "error", message: "docker refused" };
        return { kind: "applied_restart" };
      }),
      status: vi.fn(async () => ({ state: "running" })),
      canaryApiKey: vi.fn(async () => "fake-canary-key"),
    };
    const smoke = vi.fn(async () => ({ ok: true as const, runId: "run-smoke", status: "completed" }));
    const deps: BotCanaryServiceDeps = {
      runtime,
      now: () => new Date("2026-09-30T08:00:00.000Z"),
      settings: SETTINGS,
      probes: {
        fetchJson: async (url: string) => {
          if (url.startsWith("https://ghcr.io/token")) return { token: "t" };
          if (url.includes("/manifests/")) return { config: { digest: "sha256:cfg" } };
          if (url.includes("/blobs/")) return { config: { Labels: CI_LABELS } };
          if (url.includes("/compare/")) return { status: "ahead" };
          return [];
        },
      } as BotCanaryProbeDeps,
      logActivity: (async () => ({})) as unknown as BotCanaryServiceDeps["logActivity"],
      smoke: smoke as unknown as BotCanaryServiceDeps["smoke"],
      env: {},
    };
    const service = botCanaryService(store as unknown as Db, deps);
    await service.create({ reference: GOOD }, ACTOR);
    await service.tick(); // canary apply
    await service.tick(); // health wait
    await service.tick(); // smoke
    await service.tick(); // smoke ok -> wave_draining
    await service.tick(); // first wave planned; agent-b fails
    const job = (await service.current()).job;
    expect(job?.status).toBe("failed_health");
    expect(job?.failureReason).toContain("agent-b");
    // agent-c was never touched (exact match: "agent-canary" also starts with "agent-c")
    expect(appliedImages.some((entry) => entry.split(":")[0] === "agent-c")).toBe(false);
    expect(appliedImages).toHaveLength(2);
  });

  it("the canary alone is the whole fleet: the rollout finishes after the smoke", async () => {
    const h = harness({ agents: [CANARY] });
    await h.service.create({ reference: GOOD }, ACTOR);
    await h.service.tick(); // apply
    await h.service.tick(); // health wait
    await h.service.tick(); // smoke
    await h.service.tick(); // smoke ok -> wave_draining
    await h.service.tick(); // no remainder -> succeeded
    const job = (await h.service.current()).job;
    expect(job?.status).toBe("succeeded");
    expect(job?.doneBotKeys).toEqual([CANARY]);
  });
});

describe("bot canary service: abort and timeout", () => {
  it("aborts a rollout that has not switched the canary yet", async () => {
    const h = harness();
    const job = await h.service.create({ reference: GOOD }, ACTOR); // canary_waiting
    const aborted = await h.service.abort(job.id, ACTOR);
    expect(aborted.status).toBe("aborted");
    expect(h.appliedImages).toEqual([]);
  });

  it("refuses to abort once the canary switch started", async () => {
    const h = harness();
    const job = await h.service.create({ reference: GOOD }, ACTOR);
    await h.service.tick(); // canary_running
    await expect(h.service.abort(job.id, ACTOR)).rejects.toThrow(/cannot be aborted/);
  });

  it("aborts a step stuck past the timeout", async () => {
    const store = new MemoryStore();
    let clock = new Date("2026-09-30T08:00:00.000Z").getTime();
    const deps: BotCanaryServiceDeps = {
      runtime: {
        listAgents: async () => [agent(CANARY)],
        applyNow: async () => ({ kind: "deferred", reason: "window" }),
        status: async () => ({ state: "running" }),
        canaryApiKey: async () => null,
      },
      now: () => new Date(clock),
      settings: { ...SETTINGS, stepTimeoutMs: 1000 },
      probes: {
        fetchJson: async (url: string) => {
          if (url.startsWith("https://ghcr.io/token")) return { token: "t" };
          if (url.includes("/manifests/")) return { config: { digest: "sha256:cfg" } };
          if (url.includes("/blobs/")) return { config: { Labels: CI_LABELS } };
          if (url.includes("/compare/")) return { status: "ahead" };
          return [];
        },
      } as BotCanaryProbeDeps,
      logActivity: (async () => ({})) as unknown as BotCanaryServiceDeps["logActivity"],
      env: {},
    };
    const service = botCanaryService(store as unknown as Db, deps);
    const job = await service.create({ reference: GOOD }, ACTOR);
    expect(job.status).toBe("canary_waiting");
    clock += 5000;
    await service.tick();
    const current = await service.current();
    expect(current.job?.status).toBe("aborted");
    expect(current.job?.failureReason).toContain("exceeded the timeout");
  });
});

describe("bot canary service: preview", () => {
  it("verifies a reference without creating a rollout", async () => {
    const h = harness();
    const preview = await h.service.preview(GOOD);
    expect(preview.ok).toBe(true);
    expect(preview.digest).toBe(GOOD);
    const current = await h.service.current();
    expect(current.job).toBeNull();
  });

  it("refuses a malformed reference in preview", async () => {
    const h = harness();
    await expect(h.service.preview("latest")).rejects.toThrow(/sha256/);
  });
});
