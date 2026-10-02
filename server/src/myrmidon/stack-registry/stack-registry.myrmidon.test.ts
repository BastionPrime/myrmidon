// Stack registry (SUA) tests: seed coverage, refresh rewrites the cache,
// permissions (agent token → 403 on refresh), and the seed-view GET before
// the first refresh.

import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDb, instanceSettings } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { errorHandler } from "../../middleware/index.js";
import { STACK_GENERAL_KEY, STACK_SEED, STACK_SEED_NAMES, type StackDocument } from "./domain.js";
import { collectStackLocal, type CollectStackLocalOptions, type DockerImageInspectSummary } from "./collector.js";
import { readStackDocument, writeStackDocument, preserveStackGeneralKey } from "./store.js";
import { stackRegistryRoutes } from "./routes.js";
import type { ServerInfoSnapshot } from "../../server-info.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const BOARD_COMMIT = "0123456789abcdef0123456789abcdef01234567";

const GIT_SNAPSHOT: ServerInfoSnapshot = {
  processStartedAt: "2026-09-30T11:00:00.000Z",
  git: {
    available: true,
    fullSha: BOARD_COMMIT,
    shortSha: BOARD_COMMIT.slice(0, 7),
    branchName: "main",
    subject: "test subject",
    committedAt: "2026-09-30T10:00:00.000Z",
    localChanges: { available: false, unavailableReason: "git_status_unavailable" },
  },
};

function fakeImages(summaryByRef: Record<string, DockerImageInspectSummary | null>) {
  return async (ref: string) => summaryByRef[ref] ?? null;
}

const NOW = () => new Date("2026-09-30T12:00:00Z");

function collectOptions(overrides: { images?: NonNullable<CollectStackLocalOptions["images"]> } = {}) {
  return { now: NOW, serverInfo: GIT_SNAPSHOT, images: fakeImages({}), ...overrides };
}

describeEmbeddedPostgres("stack registry", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-stack-registry-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(instanceSettings);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function app(actor: unknown, collect?: Parameters<typeof collectStackLocal>[0]) {
    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => {
      (req as unknown as { actor: unknown }).actor = actor;
      next();
    });
    server.use("/api", stackRegistryRoutes(db, collect ? { collect } : {}));
    server.use(errorHandler);
    return server;
  }

  const admin = { type: "board", source: "session", userId: "admin-user", isInstanceAdmin: true, companyIds: [] };
  const member = { type: "board", source: "session", userId: "user-a", isInstanceAdmin: false, companyIds: ["company-a"] };
  const agentActor = { type: "agent", source: "agent_key", agentId: "agent-a", companyId: "company-a", keyId: "key-a" };

  it("seed covers every component of the stack list with neutral names", () => {
    expect(STACK_SEED_NAMES).toEqual([
      "paperclip",
      "myrmidon",
      "hermes-agent",
      "litellm",
      "ragflow",
      "hindsight",
      "langfuse",
      "clickhouse",
      "zabbix",
      "playwright-chromium-mcp",
      "dockergate",
      "media-tools",
      "base-images",
      "proxmox-ve",
      "node-os",
    ]);
    for (const seed of STACK_SEED) {
      expect(seed.name).toMatch(/^[a-z0-9-]+$/);
      if (seed.upstream.kind === "github") {
        // Owner case is the public registry name (NousResearch, BerriAI,
        // ClickHouse): keep the exact public owner/name pair, but no
        // non-ASCII and no internal identities — a plain public repo shape.
        expect(seed.upstream.repo).toMatch(/^[\w.-]+\/[\w.-]+$/);
        expect(seed.upstream.repo).not.toMatch(/[^\x20-\x7E]/);
        expect(seed.upstream.repo.toLowerCase().split("/")[1]).toMatch(/^[a-z0-9._-]+$/);
      }
    }
  });

  it("GET returns the seed view with all components before the first refresh", async () => {
    const res = await request(app(member)).get("/api/myrmidon/stack").expect(200);
    expect(res.body.refreshedAt).toBeNull();
    const names = res.body.components.map((c: { name: string }) => c.name);
    expect(names).toEqual([...STACK_SEED_NAMES]);
    for (const component of res.body.components) {
      expect(component).toMatchObject({
        name: expect.any(String),
        releaseSource: expect.stringMatching(/^(github-releases|github-tags|registry|package|manual)$/),
        local: expect.objectContaining({
          version: null,
          runningOn: null,
          unknownReason: "not refreshed yet",
        }),
      });
    }
  });

  it("collect fills the board commit from the same source as /api/health, digests from the docker port, honest unknowns", async () => {
    const doc = await collectStackLocal(
      collectOptions({
        images: fakeImages({
          node: { repoTag: "node:24-alpine", digest: "sha256:" + "a".repeat(64), labels: {} },
          "ghcr.io/itkadr-git/myrmidon": {
            repoTag: "ghcr.io/itkadr-git/myrmidon:myr-v1.2.2",
            digest: "sha256:" + "b".repeat(64),
            labels: {},
          },
        }),
      }),
    );
    expect(doc.refreshedAt).toBe("2026-09-30T12:00:00.000Z");
    const board = doc.components.find((c) => c.name === "myrmidon")!;
    expect(board.local.commit).toBe(BOARD_COMMIT);
    expect(board.local.runningOn).toBe("board server process");
    const baseImages = doc.components.find((c) => c.name === "base-images")!;
    expect(baseImages.local.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(baseImages.local.version).toBe("node:24-alpine");
    const hermes = doc.components.find((c) => c.name === "hermes-agent")!;
    expect(hermes.local.unknownReason).toBeTruthy(); // image absent on the test host
    expect(hermes.local.version).toBeNull();
    const proxmox = doc.components.find((c) => c.name === "proxmox-ve")!;
    expect(proxmox.local.version).toBeNull();
    expect(proxmox.local.unknownReason).toBe("not visible from the board server process");
    for (const component of doc.components) {
      // Part B seeds the carried deltas; only the seeded component has them.
      if (component.name === "hermes-agent") {
        expect(component.local.patches.map((patch) => patch.title)).toEqual([
          "gateway turn-body thread pool patch",
        ]);
      } else {
        expect(component.local.patches).toEqual([]);
      }
      expect(component.local.checkedAt).toBe("2026-09-30T12:00:00.000Z");
    }
  });

  it("collect degrades the board commit to an honest unknown when git metadata is unavailable", async () => {
    const doc = await collectStackLocal({
      now: NOW,
      serverInfo: {
        processStartedAt: "2026-09-30T11:00:00.000Z",
        git: { available: false, unavailableReason: "git_unavailable" },
      },
      images: fakeImages({}),
    });
    const board = doc.components.find((c) => c.name === "myrmidon")!;
    expect(board.local.commit).toBeNull();
    expect(board.local.unknownReason).toBe("board build commit unavailable (git_unavailable)");
  });

  it("refresh rewrites the cache and GET reflects it", async () => {
    const before = await readStackDocument(db);
    expect(before.components).toEqual([]);
    await request(app(admin, collectOptions()))
      .post("/api/myrmidon/stack/refresh")
      .expect(200)
      .expect((res) => {
        expect(res.body.refreshedAt).toBe("2026-09-30T12:00:00.000Z");
        expect(res.body.components.length).toBe(STACK_SEED.length);
      });
    const stored = await readStackDocument(db);
    expect(stored.components.length).toBe(STACK_SEED.length);
    const board = stored.components.find((c) => c.name === "myrmidon")!;
    expect(board.local.commit).toBe(BOARD_COMMIT);
    const row = await db
      .select({ general: instanceSettings.general })
      .from(instanceSettings)
      .where(eq(instanceSettings.singletonKey, "default"))
      .then((rows) => rows[0]);
    expect(row?.general?.[STACK_GENERAL_KEY]).toMatchObject({ version: 2 });
    const seen = await request(app(member, collectOptions())).get("/api/myrmidon/stack").expect(200);
    expect(seen.body.refreshedAt).toBe("2026-09-30T12:00:00.000Z");
    expect(seen.body.components.find((c: { name: string }) => c.name === "myrmidon").local.commit).toBe(BOARD_COMMIT);
  });

  it("writeStackDocument stores the full document and preserveStackGeneralKey carries it", async () => {
    const doc = await collectStackLocal(collectOptions());
    await writeStackDocument(db, doc);
    const raw: StackDocument = (await readStackDocument(db)) as StackDocument;
    expect(raw.components.length).toBe(doc.components.length);
    expect(preserveStackGeneralKey({ unrelated: true, [STACK_GENERAL_KEY]: raw })).toEqual({
      [STACK_GENERAL_KEY]: raw,
    });
    expect(preserveStackGeneralKey({ unrelated: true })).toEqual({});
  });

  it("agent tokens and non-admin members cannot refresh (403); nothing is written", async () => {
    await request(app(agentActor, collectOptions())).post("/api/myrmidon/stack/refresh").expect(403);
    await request(app(member, collectOptions())).post("/api/myrmidon/stack/refresh").expect(403);
    const stored = await readStackDocument(db);
    expect(stored.components).toEqual([]);
  });

  it("anonymous callers are rejected on both routes", async () => {
    // Same contract as the maintenance routes: an actor that resolved to
    // "none" fails the board gate with 403 (the gate never distinguishes
    // "no session" from "wrong kind of session").
    const server = app({ type: "none" });
    await request(server).get("/api/myrmidon/stack").expect(403);
    await request(server).post("/api/myrmidon/stack/refresh").expect(403);
  });

  it("a failing probe keeps the previous cache and answers 503", async () => {
    const good = await collectStackLocal(collectOptions());
    await writeStackDocument(db, good);
    const boom = async () => {
      throw new Error("socket unreachable");
    };
    const res = await request(app(admin, collectOptions({ images: boom })))
      .post("/api/myrmidon/stack/refresh")
      .expect(503);
    expect(res.body.error).toBe("stack refresh failed");
    const stored = await readStackDocument(db);
    expect(stored.refreshedAt).toBe(good.refreshedAt);
  });
});
