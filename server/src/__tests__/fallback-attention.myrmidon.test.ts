// myrmidon(BOT-RUNTIME-TUNING D): the attention feed integration — a recorded
// fallback signal becomes exactly ONE card per agent on the desk, subject is
// the agent, severity medium, and the card disappears when the next sweep
// clears the signals. Live embedded postgres (the TRACING-HEALTH part D
// recipe): the feed queries real tables.

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agents, companies, createDb } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

vi.mock("../middleware/logger.js", () => ({
  logger: {
    child: vi.fn(function child() {
      return this;
    }),
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
  httpLogger: vi.fn(),
}));

import { attentionService } from "../services/attention.js";
import {
  fallbackDedupKey,
  fallbackSignalForShare,
  readFallbackSignalSettings,
  recordModelFallbackSignals,
  resetModelFallbackSignals,
} from "../myrmidon/litellm-fallback-signal/attention.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const SETTINGS = readFallbackSignalSettings({ MYRMIDON_MODEL_FALLBACK_ENABLED: "1" });

describeEmbeddedPostgres("model fallback attention feed card (BOT-RUNTIME-TUNING D)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let agentId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-fallback-attention-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    resetModelFallbackSignals();
    await db.delete(activityLog);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "company-a",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "agent-a",
      adapterType: "hermes_gateway",
      status: "idle",
    });
  }

  it("a tripped fallback share is one medium card per agent, subject = the agent", async () => {
    await seedCompany();
    recordModelFallbackSignals(companyId, [
      fallbackSignalForShare(
        { agentId, total: 50, fallbacks: 15, sharePct: 30, servedModels: ["model-swapped"] },
        SETTINGS,
        new Date().toISOString(),
      ),
    ]);
    const feed = await attentionService(db).list(companyId);
    const cards = feed.items.filter((item) => item.dedupKey === fallbackDedupKey(agentId));
    expect(cards).toHaveLength(1);
    const card = cards[0]!;
    expect(card.sourceKind).toBe("model_fallback_alert");
    expect(card.severity).toBe("medium");
    expect(card.subject.kind).toBe("agent");
    expect(card.subject.id).toBe(agentId);
    expect(card.whyNow).toContain("30% of this bot's 50 gateway calls");
    expect(card.relatedIssue).toBeNull();
    expect(feed.countsBySourceKind.model_fallback_alert).toBe(1);
  });

  it("an empty sweep raises no card", async () => {
    await seedCompany();
    recordModelFallbackSignals(companyId, []);
    const feed = await attentionService(db).list(companyId);
    expect(feed.items.filter((item) => item.sourceKind === "model_fallback_alert")).toHaveLength(0);
  });

  it("the card disappears when the next sweep clears the agent", async () => {
    await seedCompany();
    recordModelFallbackSignals(companyId, [
      fallbackSignalForShare(
        { agentId, total: 50, fallbacks: 15, sharePct: 30, servedModels: ["model-swapped"] },
        SETTINGS,
        new Date().toISOString(),
      ),
    ]);
    const before = await attentionService(db).list(companyId);
    expect(before.items.filter((item) => item.sourceKind === "model_fallback_alert")).toHaveLength(1);

    recordModelFallbackSignals(companyId, []);
    const after = await attentionService(db).list(companyId);
    expect(after.items.filter((item) => item.sourceKind === "model_fallback_alert")).toHaveLength(0);
  });
});
