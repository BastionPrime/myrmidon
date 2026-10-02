// myrmidon(TRACING-HEALTH part D): the attention feed integration — a
// recorded tracing signal becomes exactly ONE operator card on the desk,
// with the right severity, and the card disappears when the state recovers.
// Live embedded postgres (the AUTO-RESUME sweep test recipe): the feed
// queries real tables.

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
  recordTracingHealthSignal,
  resetTracingHealthSignals,
  TRACING_ATTENTION_DEDUP_KEY,
} from "../myrmidon/tracing-health/attention.js";
import type { TracingHealthReport } from "../myrmidon/tracing-health/domain.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function report(overrides: Partial<TracingHealthReport> = {}): TracingHealthReport {
  return {
    enabled: true,
    state: "degraded",
    checkedAt: new Date().toISOString(),
    window: { from: new Date().toISOString(), to: new Date().toISOString() },
    evidence: {
      eventsInWindow: 0,
      gatewayRequestsInWindow: 30,
      callbackErrorRate: 0,
      deliveryRatio: 0,
      legacyRejections: 0,
    },
    reason: "the gateway served traffic but no tracing events landed in the window",
    ...overrides,
  };
}

describeEmbeddedPostgres("tracing health attention feed card (TRACING-HEALTH part D)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-tracing-attention-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    resetTracingHealthSignals();
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
  }

  it("a degraded tracing signal is one operator card on the desk", async () => {
    await seedCompany();
    recordTracingHealthSignal(companyId, report());
    const feed = await attentionService(db).list(companyId);
    const cards = feed.items.filter((item) => item.dedupKey === TRACING_ATTENTION_DEDUP_KEY);
    expect(cards).toHaveLength(1);
    const card = cards[0]!;
    expect(card.severity).toBe("high");
    expect(card.subject.title).toBe("LLM tracing");
    expect(card.whyNow).toContain("operator");
    // The card is operator-facing: no issue, no owner — subject is the check.
    expect(card.relatedIssue).toBeNull();
  });

  it("an unknown tracing signal is one medium-severity card", async () => {
    await seedCompany();
    recordTracingHealthSignal(
      companyId,
      report({ state: "unknown", reason: "the ClickHouse events probe failed" }),
    );
    const feed = await attentionService(db).list(companyId);
    const cards = feed.items.filter((item) => item.dedupKey === TRACING_ATTENTION_DEDUP_KEY);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.severity).toBe("medium");
  });

  it("a healthy (ok) and a quiet (idle) report raise no card at all", async () => {
    await seedCompany();
    recordTracingHealthSignal(companyId, report({ state: "ok" }));
    const feed = await attentionService(db).list(companyId);
    expect(feed.items.filter((item) => item.dedupKey === TRACING_ATTENTION_DEDUP_KEY)).toHaveLength(0);

    recordTracingHealthSignal(companyId, report({ state: "idle", reason: "the gateway served no traffic in the window" }));
    const feed2 = await attentionService(db).list(companyId);
    expect(feed2.items.filter((item) => item.dedupKey === TRACING_ATTENTION_DEDUP_KEY)).toHaveLength(0);
  });

  it("recovery clears the card on the next feed read (state dedup, no dismissal)", async () => {
    await seedCompany();
    recordTracingHealthSignal(companyId, report());
    const redFeed = await attentionService(db).list(companyId);
    expect(redFeed.items.filter((item) => item.dedupKey === TRACING_ATTENTION_DEDUP_KEY)).toHaveLength(1);

    recordTracingHealthSignal(companyId, report({ state: "ok" }));
    const greenFeed = await attentionService(db).list(companyId);
    expect(greenFeed.items.filter((item) => item.dedupKey === TRACING_ATTENTION_DEDUP_KEY)).toHaveLength(0);
  });
});
