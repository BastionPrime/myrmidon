// Stack registry (SUA, part B) tests: the release check against injected
// sources, the patch-closed rule over the compare API, the attention cards and
// the route permissions. No live network: the JSON port is injected.

import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDb, instanceSettings } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { errorHandler } from "../../middleware/index.js";
import { checkStackReleases, startStackCheckSweep } from "./check.js";
import {
  buildStackAttentionCards,
  stackComponentNeedsAttention,
} from "./attention.js";
import {
  compareContainsFix,
  countBehind,
  extractReleaseNotes,
  normaliseVersion,
  readReleaseList,
  type StackFetchJson,
  type StackHttpResponse,
} from "./releases.js";
import { readStackCheckIntervalSec } from "./settings.js";
import { seedStackDocument, type StackDocument, type StackLocalState } from "./domain.js";
import { readStackDocument, writeStackDocument } from "./store.js";
import { stackRegistryRoutes } from "./routes.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const NOW = () => new Date("2026-10-02T03:00:00.000Z");

type RouteValue = StackHttpResponse | ((url: string) => StackHttpResponse);

/** A JSON port that answers by URL substring; anything else is 404. */
function fakePort(routes: Record<string, RouteValue>): StackFetchJson {
  return async (url) => {
    const key = Object.keys(routes).find((candidate) => url.includes(candidate));
    if (!key) return { status: 404, json: null };
    const value = routes[key]!;
    return typeof value === "function" ? value(url) : value;
  };
}

function langfuseReleases() {
  return [
    {
      tag_name: "3.2.0",
      published_at: "2026-09-28T00:00:00Z",
      body: "security fix for the session cookie (CVE-2026-12345)\nbreaking: removed the legacy API\n- minor cleanup",
    },
    { tag_name: "3.1.0", published_at: "2026-09-10T00:00:00Z", body: "Routine release." },
    { tag_name: "3.0.0", published_at: "2026-08-01T00:00:00Z", body: "Release." },
  ];
}

function documentWithLocal(overrides: Record<string, Partial<StackLocalState>>): StackDocument {
  const doc = seedStackDocument();
  return {
    ...doc,
    components: doc.components.map((component) =>
      overrides[component.name]
        ? { ...component, local: { ...component.local, ...overrides[component.name] } }
        : component,
    ),
  };
}

describe("stack release check helpers", () => {
  it("reads the release list newest-first and normalises versions", () => {
    const records = readReleaseList("github-releases", langfuseReleases());
    expect(records.map((r) => r.tag)).toEqual(["3.2.0", "3.1.0", "3.0.0"]);
    expect(normaliseVersion("langfuse/langfuse:3.0.0")).toBe("3.0.0");
    expect(normaliseVersion("v1.3.1")).toBe("1.3.1");
    expect(countBehind(records, "langfuse/langfuse:3.0.0")).toEqual({ latest: "3.2.0", behindBy: 2 });
    expect(countBehind(records, "langfuse/langfuse:3.2.0")).toEqual({ latest: "3.2.0", behindBy: 0 });
    // Our version is not part of the feed: an honest unknown, not a guess.
    expect(countBehind(records, "langfuse/langfuse:1.0.0").behindBy).toBeNull();
  });

  it("keeps only notable release-note lines, bounded, and flags security", () => {
    const notes = extractReleaseNotes(readReleaseList("github-releases", langfuseReleases()), { limit: 1 });
    expect(notes?.hasSecurity).toBe(true);
    expect(notes?.lines).toHaveLength(1);
    expect(notes?.truncated).toBe(true);
    expect(notes?.lines[0]).toContain("security fix");
    expect(notes?.lines[0]).toContain("3.2.0");
  });

  it("detects a known fix commit inside the compare range", () => {
    const json = { commits: [{ sha: "24758cf4b8123456789012345678901234567890" }] };
    expect(compareContainsFix(json, ["24758cf4b8"])).toBe(true);
    expect(compareContainsFix({ commits: [{ sha: "deadbeef" }] }, ["24758cf4b8"])).toBe(false);
    expect(compareContainsFix(null, ["24758cf4b8"])).toBe(false);
  });

  it("defaults the release-check interval to off", () => {
    expect(readStackCheckIntervalSec({} as NodeJS.ProcessEnv)).toBe(0);
    expect(readStackCheckIntervalSec({ MYRMIDON_STACK_CHECK_INTERVAL_SEC: "0" } as NodeJS.ProcessEnv)).toBe(0);
    expect(readStackCheckIntervalSec({ MYRMIDON_STACK_CHECK_INTERVAL_SEC: "abc" } as NodeJS.ProcessEnv)).toBe(0);
    expect(readStackCheckIntervalSec({ MYRMIDON_STACK_CHECK_INTERVAL_SEC: "10" } as NodeJS.ProcessEnv)).toBe(60);
    expect(readStackCheckIntervalSec({ MYRMIDON_STACK_CHECK_INTERVAL_SEC: "86400" } as NodeJS.ProcessEnv)).toBe(86400);
  });
});

describe("stack attention cards", () => {
  it("covers a lagging component, keeps severity by security lines and dedupKey by latest", () => {
    const doc = documentWithLocal({ langfuse: { version: "langfuse/langfuse:3.0.0" } });
    doc.components = doc.components.map((component) =>
      component.name === "langfuse"
        ? {
            ...component,
            upstreamState: {
              checkedAt: "2026-10-02T03:00:00.000Z",
              latest: "3.2.0",
              latestPublishedAt: "2026-09-28T00:00:00Z",
              firstSeenAt: "2026-10-01T03:00:00.000Z",
              previousLatest: "3.1.0",
              behindBy: 2,
              notes: { lines: ["3.2.0 — security fix"], truncated: false, hasSecurity: true },
              error: null,
            },
          }
        : component,
    );
    const cards = buildStackAttentionCards(doc);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      component: "langfuse",
      latest: "3.2.0",
      behindBy: 2,
      severity: "high",
      dedupKey: "stack:langfuse:3.2.0",
      activityAt: "2026-09-28T00:00:00Z",
    });
    expect(cards[0]!.summaryExcerpt).toContain("security fix");
    // First check on the same document made no card before the upstream state.
    expect(buildStackAttentionCards(seedStackDocument())).toHaveLength(0);
  });

  it("surfaces a new latest even without a known lag, and stays silent when up to date", () => {
    const base = documentWithLocal({ langfuse: { version: "langfuse/langfuse:3.2.0" } });
    const component = base.components.find((c) => c.name === "langfuse")!;
    const upstream = {
      checkedAt: "2026-10-02T03:00:00.000Z",
      latest: "3.2.0",
      latestPublishedAt: null,
      firstSeenAt: "2026-10-02T03:00:00.000Z",
      previousLatest: "3.1.0",
      behindBy: 0,
      notes: null,
      error: null,
    };
    expect(stackComponentNeedsAttention({ ...component, upstreamState: upstream })).toBe(true);
    const cards = buildStackAttentionCards({
      ...base,
      components: base.components.map((c) => (c.name === "langfuse" ? { ...c, upstreamState: upstream } : c)),
    });
    expect(cards).toHaveLength(1);
    expect(cards[0]!.severity).toBe("medium");
    // Same latest as the previous check and we are on it: no card.
    expect(stackComponentNeedsAttention({ ...component, upstreamState: { ...upstream, previousLatest: "3.2.0" } })).toBe(false);
  });
});

describeEmbeddedPostgres("stack release check", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-stack-check-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(instanceSettings);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function app(actor: unknown, check?: Parameters<typeof stackRegistryRoutes>[1]) {
    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => {
      (req as unknown as { actor: unknown }).actor = actor;
      next();
    });
    server.use("/api", stackRegistryRoutes(db, check));
    server.use(errorHandler);
    return server;
  }

  const admin = { type: "board", source: "session", userId: "admin-user", isInstanceAdmin: true, companyIds: [] };
  const member = { type: "board", source: "session", userId: "user-a", isInstanceAdmin: false, companyIds: ["company-a"] };
  const agentActor = { type: "agent", source: "agent_key", agentId: "agent-a", companyId: "company-a", keyId: "key-a" };

  it("check updates the cache with latest, lag and the release-note excerpt", async () => {
    await writeStackDocument(db, documentWithLocal({ langfuse: { version: "langfuse/langfuse:3.0.0" } }));
    const port = fakePort({ "repos/langfuse/langfuse/releases": { status: 200, json: langfuseReleases() } });
    const next = await checkStackReleases(db, { fetchJson: port, now: NOW });
    expect(next.version).toBe(2);
    expect(next.checkedAt).toBe("2026-10-02T03:00:00.000Z");
    const langfuse = next.components.find((c) => c.name === "langfuse")!;
    expect(langfuse.upstreamState).toMatchObject({
      latest: "3.2.0",
      latestPublishedAt: "2026-09-28T00:00:00Z",
      previousLatest: null,
      behindBy: 2,
    });
    expect(langfuse.upstreamState?.notes?.hasSecurity).toBe(true);
    // The written cache is readable back and version 1 documents still parse.
    const stored = await readStackDocument(db);
    expect(stored.checkedAt).toBe("2026-10-02T03:00:00.000Z");
    expect(stored.components.find((c) => c.name === "langfuse")?.upstreamState?.latest).toBe("3.2.0");
    // A component without a source is left untouched.
    expect(next.components.find((c) => c.name === "proxmox-ve")?.upstreamState).toBeUndefined();
  });

  it("records a per-component HTTP error without failing the whole check", async () => {
    await writeStackDocument(db, documentWithLocal({ langfuse: { version: "langfuse/langfuse:3.0.0" } }));
    const port = fakePort({ "repos/langfuse/langfuse/releases": { status: 403, json: null } });
    const next = await checkStackReleases(db, { fetchJson: port, now: NOW });
    const langfuse = next.components.find((c) => c.name === "langfuse")!;
    expect(langfuse.upstreamState?.error).toBe("github 403");
    expect(langfuse.upstreamState?.latest).toBeNull();
  });

  it("closes the patch when the upstream range carries the fix commit", async () => {
    await writeStackDocument(db, seedStackDocument());
    const port = fakePort({
      "repos/NousResearch/hermes-agent/releases": {
        status: 200,
        json: [{ tag_name: "v2026.10.1", published_at: "2026-10-01T00:00:00Z", body: "Pool limits fixed." }],
      },
      "repos/NousResearch/hermes-agent/compare": {
        status: 200,
        json: { status: "ahead", commits: [{ sha: "24758cf4b8123456789012345678901234567890" }] },
      },
    });
    const next = await checkStackReleases(db, { fetchJson: port, now: NOW });
    const hermes = next.components.find((c) => c.name === "hermes-agent")!;
    expect(hermes.local.patches).toHaveLength(1);
    expect(hermes.local.patches[0]).toMatchObject({ state: "closed", fixCommits: ["24758cf4b8"] });
    expect(hermes.patchClosed).toMatchObject({ state: "closed" });
  });

  it("keeps the patch open when the fix commit is outside the range, and unknown on a 404", async () => {
    await writeStackDocument(db, seedStackDocument());
    const openPort = fakePort({
      "repos/NousResearch/hermes-agent/releases": {
        status: 200,
        json: [{ tag_name: "v2026.10.1", published_at: "2026-10-01T00:00:00Z", body: null }],
      },
      "repos/NousResearch/hermes-agent/compare": { status: 200, json: { status: "ahead", commits: [{ sha: "aaaaaaaaaaaa" }] } },
    });
    const open = await checkStackReleases(db, { fetchJson: openPort, now: NOW });
    expect(open.components.find((c) => c.name === "hermes-agent")?.patchClosed?.state).toBe("open");

    const unknownPort = fakePort({
      "repos/NousResearch/hermes-agent/releases": {
        status: 200,
        json: [{ tag_name: "v2026.10.1", published_at: "2026-10-01T00:00:00Z", body: null }],
      },
      "repos/NousResearch/hermes-agent/compare": { status: 404, json: null },
    });
    const unknown = await checkStackReleases(db, { fetchJson: unknownPort, now: NOW });
    expect(unknown.components.find((c) => c.name === "hermes-agent")?.patchClosed?.state).toBe("unknown");
  });

  it("a transport failure rejects the check and preserves the previous cache", async () => {
    const good = documentWithLocal({ langfuse: { version: "langfuse/langfuse:3.0.0" } });
    good.checkedAt = "2026-10-01T00:00:00.000Z";
    await writeStackDocument(db, good);
    const broken: StackFetchJson = async () => {
      throw new Error("network unreachable");
    };
    await expect(checkStackReleases(db, { fetchJson: broken, now: NOW })).rejects.toThrow("network unreachable");
    const stored = await readStackDocument(db);
    expect(stored.checkedAt).toBe("2026-10-01T00:00:00.000Z");
    expect(stored.components.find((c) => c.name === "langfuse")?.upstreamState).toBeUndefined();
  });

  it("agent and non-admin tokens cannot run the check (403); nothing is written", async () => {
    const port = fakePort({ "repos/langfuse/langfuse/releases": { status: 200, json: langfuseReleases() } });
    await request(app(agentActor, { check: { fetchJson: port, now: NOW } })).post("/api/myrmidon/stack/check").expect(403);
    await request(app(member, { check: { fetchJson: port, now: NOW } })).post("/api/myrmidon/stack/check").expect(403);
    expect((await readStackDocument(db)).components).toEqual([]);
  });

  it("admin check answers 200 with fakes and 503 without a network, keeping the cache", async () => {
    const port = fakePort({ "repos/langfuse/langfuse/releases": { status: 200, json: langfuseReleases() } });
    await request(app(admin, { check: { fetchJson: port, now: NOW } }))
      .post("/api/myrmidon/stack/check")
      .expect(200)
      .expect((res) => {
        expect(res.body.checkedAt).toBe("2026-10-02T03:00:00.000Z");
        expect(res.body.components.find((c: { name: string }) => c.name === "langfuse").upstreamState.latest).toBe("3.2.0");
      });
    const broken: StackFetchJson = async () => {
      throw new Error("network unreachable");
    };
    const res = await request(app(admin, { check: { fetchJson: broken, now: NOW } }))
      .post("/api/myrmidon/stack/check")
      .expect(503);
    expect(res.body.error).toBe("stack check failed");
    expect((await readStackDocument(db)).components.find((c) => c.name === "langfuse")?.upstreamState?.latest).toBe("3.2.0");
  });

  it("the sweep does not touch the network while the interval is off", () => {
    const saved = process.env.MYRMIDON_STACK_CHECK_INTERVAL_SEC;
    delete process.env.MYRMIDON_STACK_CHECK_INTERVAL_SEC;
    let calls = 0;
    const port: StackFetchJson = async () => {
      calls += 1;
      return { status: 200, json: [] };
    };
    const stop = startStackCheckSweep(db, { fetchJson: port });
    stop();
    if (saved === undefined) delete process.env.MYRMIDON_STACK_CHECK_INTERVAL_SEC;
    else process.env.MYRMIDON_STACK_CHECK_INTERVAL_SEC = saved;
    expect(calls).toBe(0);
  });
});