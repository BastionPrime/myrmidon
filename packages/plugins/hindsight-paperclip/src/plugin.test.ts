import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { Agent, Issue, IssueComment, PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { createHindsightPlugin, type FetchLike } from "./plugin.js";
import manifest from "./manifest.js";
import { resolveBank } from "./bank.js";

// Synthetic data only: fake UUID-shaped ids, a mock fetch over an in-memory
// "hindsight service". No real addresses (the API URL is a placeholder the
// mock never dereferences), no memory content beyond synthetic strings.

const COMPANY = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";

const AGENT_ADM = "33333333-3333-4333-8333-333333333333"; // card bank: adm
const AGENT_BBQ = "44444444-4444-4444-8444-444444444444"; // card bank: fleet-bbq
const AGENT_SHOP = "55555555-5555-4555-8555-555555555555"; // card bank: shop-public
const AGENT_UNMAPPED = "66666666-6666-4666-8666-666666666666"; // no bank anywhere

const API_URL = "http://hindsight.invalid";

interface MockCall {
  method: string;
  path: string;
  body: {
    query?: string;
    items?: Array<{ content: string; document_id?: string; metadata?: Record<string, unknown> }>;
  };
}

interface MockHindsight {
  calls: MockCall[];
  banks: Map<string, Array<{ documentId?: string; content: string; metadata: Record<string, unknown> }>>;
  fetch: FetchLike;
}

function mockHindsight(): MockHindsight {
  const calls: MockCall[] = [];
  const banks = new Map<string, Array<{ documentId?: string; content: string; metadata: Record<string, unknown> }>>();
  const bank = (id: string) => {
    if (!banks.has(id)) banks.set(id, []);
    return banks.get(id)!;
  };
  const fetch: FetchLike = async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const path = url.slice(API_URL.length);
    const rawBody = init?.body !== undefined
      ? JSON.parse(String(init.body)) as Partial<MockCall["body"]>
      : {};
    const body: MockCall["body"] = rawBody;
    calls.push({ method, path, body });
    if (method === "POST" && path.startsWith("/v1/default/banks/") && path.endsWith("/memories/recall")) {
      const results = bank(currentBankId(path)).map((item) => ({ text: item.content }));
      return jsonResponse({ results });
    }
    if (method === "POST" && path.startsWith("/v1/default/banks/") && path.endsWith("/memories")) {
      const target = currentBankId(path);
      for (const item of body.items ?? []) {
        bank(target).push({
          documentId: item.document_id,
          content: item.content,
          metadata: item.metadata ?? {},
        });
      }
      return jsonResponse({ ok: true });
    }
    if (path === "/health") return jsonResponse({ ok: true });
    return jsonResponse({ error: "unhandled" }, 404);
  };
  return { calls, banks, fetch };
}

function currentBankId(path: string): string {
  // /v1/default/banks/<encoded>/memories[/recall]
  return decodeURIComponent(path.split("/")[4]);
}

function firstRetainItem(call: MockCall): { content: string; document_id?: string; metadata?: Record<string, unknown> } {
  const item = call.body.items?.[0];
  if (!item) throw new Error("retain call carried no items");
  return item;
}

function retainMetadata(call: MockCall): Record<string, unknown> {
  return firstRetainItem(call).metadata ?? {};
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

function agent(input: { id: string; name: string; bankId?: string | null }): Agent {
  const adapterConfig: Record<string, unknown> = {};
  if (input.bankId != null) adapterConfig["hindsight"] = { bankId: input.bankId };
  return {
    id: input.id,
    companyId: COMPANY,
    name: input.name,
    urlKey: input.name,
    role: "engineer",
    title: null,
    icon: null,
    status: "idle",
    reportsTo: null,
    capabilities: null,
    adapterType: "hermes_gateway",
    adapterConfig,
    runtimeConfig: {} as Agent["runtimeConfig"],
    defaultEnvironmentId: null,
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: {} as Agent["permissions"],
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function issue(input: { id: string; title: string; assigneeAgentId?: string | null }): Issue {
  const now = new Date();
  return {
    id: input.id,
    companyId: COMPANY,
    projectId: PROJECT,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: input.title,
    description: null,
    status: "todo",
    workMode: "standard",
    priority: "medium",
    reviewPolicy: null,
    assigneeAgentId: input.assigneeAgentId ?? null,
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    responsibleUserId: null,
    issueNumber: 1,
    identifier: "T-1",
    originKind: undefined,
    originId: null,
    originRunId: null,
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

function comment(input: { id: string; issueId: string; body: string; authorAgentId?: string | null; authorUserId?: string | null }): IssueComment {
  const now = new Date();
  return {
    id: input.id,
    companyId: COMPANY,
    issueId: input.issueId,
    authorType: input.authorAgentId ? "agent" : "user",
    authorAgentId: input.authorAgentId ?? null,
    authorUserId: input.authorUserId ?? null,
    body: input.body,
    presentation: null,
    metadata: null,
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

describe("bank resolution", () => {
  const config = {
    bankByAgentId: { [AGENT_UNMAPPED]: "fleet-work", "99999999-9999-4999-8999-999999999999": "fleet-life" },
  };
  const agents = new Map<string, Agent>([
    [AGENT_ADM, agent({ id: AGENT_ADM, name: "ops-agent", bankId: "adm" })],
    [AGENT_BBQ, agent({ id: AGENT_BBQ, name: "bbq-grill", bankId: "fleet-bbq" })],
    [AGENT_SHOP, agent({ id: AGENT_SHOP, name: "bbq-customer-support", bankId: "shop-public" })],
    [AGENT_UNMAPPED, agent({ id: AGENT_UNMAPPED, name: "work-agent" })],
  ]);

  it("prefers the agent card bank", async () => {
    const resolution = await resolveBank({
      agentId: AGENT_ADM,
      companyId: COMPANY,
      getAgent: (id) => Promise.resolve(agents.get(id) ?? null),
      config,
    });
    assert.deepEqual(resolution, { bankId: "adm", source: "agent-card", agentName: "ops-agent" });
  });

  it("falls back to the config map when the card has no bank", async () => {
    const resolution = await resolveBank({
      agentId: AGENT_UNMAPPED,
      companyId: COMPANY,
      getAgent: (id) => Promise.resolve(agents.get(id) ?? null),
      config,
    });
    assert.deepEqual(resolution, { bankId: "fleet-work", source: "config-map", agentName: "work-agent" });
  });

  it("returns null (closed) when the agent is in neither source", async () => {
    const unknownAgent = "77777777-7777-4777-8777-777777777777";
    const resolution = await resolveBank({
      agentId: unknownAgent,
      companyId: COMPANY,
      getAgent: () => Promise.resolve(null),
      config,
    });
    assert.equal(resolution, null);
  });

  it("a blank bankId on the card is not a bank", async () => {
    const blankCard = "88888888-8888-4888-8888-888888888888";
    const resolution = await resolveBank({
      agentId: blankCard,
      companyId: COMPANY,
      getAgent: () => Promise.resolve(agent({ id: blankCard, name: "blank", bankId: "   " })),
      config,
    });
    assert.equal(resolution, null);
  });

  it("an agent lookup error closes the agent rather than falling through to a shared bank", async () => {
    const resolution = await resolveBank({
      agentId: AGENT_ADM,
      companyId: COMPANY,
      getAgent: () => Promise.reject(new Error("lookup failed")),
      config: {},
    });
    assert.equal(resolution, null);
  });
});

describe("hindsight plugin memory routing", () => {
  it("routes through the three paths with one rule", async () => {
    const hindsight = mockHindsight();
    const harness = createTestHarness({
      manifest: manifest as PaperclipPluginManifestV1,
      config: { hindsightApiUrl: API_URL },
    });
    harness.seed({
      agents: [
        agent({ id: AGENT_ADM, name: "ops-agent", bankId: "adm" }),
        agent({ id: AGENT_BBQ, name: "bbq-grill", bankId: "fleet-bbq" }),
      ],
      issues: [
        issue({ id: "issue-run", title: "Deploy the fleet", assigneeAgentId: AGENT_ADM }),
        issue({ id: "issue-comment", title: "Marinate check", assigneeAgentId: AGENT_BBQ }),
      ],
      issueComments: [
        comment({ id: "comment-bbq", issueId: "issue-comment", body: "bbq agent comment", authorAgentId: AGENT_BBQ }),
      ],
    });
    const plugin = createHindsightPlugin({ fetchImpl: hindsight.fetch });
    await plugin.definition.setup(harness.ctx);

    // Path 1: agent.run.started → recall into the running agent's bank.
    await harness.emit("agent.run.started", { agentId: AGENT_ADM, runId: "run-1", issueId: "issue-run" }, { companyId: COMPANY, entityId: "issue-run" });
    // Path 2: issue.comment.created → retain into the comment author's bank.
    await harness.emit("issue.comment.created", { commentId: "comment-bbq", agentId: AGENT_BBQ }, { companyId: COMPANY, entityId: "issue-comment" });
    // Path 3: the tools → the invoking agent's bank.
    const toolRecall = await harness.executeTool("hindsight_recall", { query: "marinade" }, { agentId: AGENT_BBQ, runId: "run-2", companyId: COMPANY, projectId: PROJECT });
    await harness.executeTool("hindsight_retain", { content: "shop prefers charcoal" }, { agentId: AGENT_BBQ, runId: "run-2", companyId: COMPANY, projectId: PROJECT });

    // run-1 recall hit adm. run-2 recall (fresh run, empty cache) hit
    // fleet-bbq and found the comment retained just above.
    assert.ok(toolRecall.content!.includes("bbq agent comment"));
    const recallBanks = hindsight.calls
      .filter((call) => call.path.endsWith("/memories/recall"))
      .map((call) => currentBankId(call.path));
    assert.deepEqual(recallBanks, ["adm", "fleet-bbq"]);

    // Retentions: one from the comment, one from the tool, both fleet-bbq.
    const retains = hindsight.calls.filter((call) => call.path.endsWith("/memories") && call.method === "POST");
    assert.deepEqual(
      retains.map((call) => currentBankId(call.path)),
      ["fleet-bbq", "fleet-bbq"],
    );
    // Retain metadata carries agentName.
    assert.equal(retainMetadata(retains[0]!)["agentName"], "bbq-grill");
    assert.equal(retainMetadata(retains[0]!)["agentId"], AGENT_BBQ);
    assert.equal(firstRetainItem(retains[0]!)["document_id"], "comment-bbq");
    assert.equal(retainMetadata(retains[1]!)["agentName"], "bbq-grill");
  });

  it("a human comment retains into the ticket assignee's bank", async () => {
    const hindsight = mockHindsight();
    const harness = createTestHarness({
      manifest: manifest as PaperclipPluginManifestV1,
      config: { hindsightApiUrl: API_URL },
    });
    harness.seed({
      agents: [agent({ id: AGENT_BBQ, name: "bbq-grill", bankId: "fleet-bbq" })],
      issues: [issue({ id: "issue-human", title: "Order question", assigneeAgentId: AGENT_BBQ })],
      issueComments: [
        comment({ id: "comment-human", issueId: "issue-human", body: "human asks about delivery", authorUserId: "user-1" }),
      ],
    });
    const plugin = createHindsightPlugin({ fetchImpl: hindsight.fetch });
    await plugin.definition.setup(harness.ctx);

    await harness.emit(
      "issue.comment.created",
      { commentId: "comment-human", agentId: null },
      { companyId: COMPANY, entityId: "issue-human" },
    );

    const retains = hindsight.calls.filter((call) => call.path.endsWith("/memories") && call.method === "POST");
    assert.equal(retains.length, 1);
    assert.equal(currentBankId(retains[0]!.path), "fleet-bbq");
    assert.equal(firstRetainItem(retains[0]!)["document_id"], "comment-human");
    assert.equal(retainMetadata(retains[0]!)["agentName"], "bbq-grill");
  });

  it("an agent absent from the map performs no retain and no recall", async () => {
    const hindsight = mockHindsight();
    const harness = createTestHarness({
      manifest: manifest as PaperclipPluginManifestV1,
      config: { hindsightApiUrl: API_URL },
    });
    harness.seed({
      agents: [agent({ id: AGENT_UNMAPPED, name: "orphan-agent" })],
      issues: [issue({ id: "issue-orphan", title: "Unrouted work", assigneeAgentId: AGENT_UNMAPPED })],
      issueComments: [
        comment({ id: "comment-orphan", issueId: "issue-orphan", body: "orphan comment", authorAgentId: AGENT_UNMAPPED }),
      ],
    });
    const plugin = createHindsightPlugin({ fetchImpl: hindsight.fetch });
    await plugin.definition.setup(harness.ctx);

    await harness.emit("agent.run.started", { agentId: AGENT_UNMAPPED, runId: "run-o", issueId: "issue-orphan" }, { companyId: COMPANY, entityId: "issue-orphan" });
    await harness.emit("issue.comment.created", { commentId: "comment-orphan", agentId: AGENT_UNMAPPED }, { companyId: COMPANY, entityId: "issue-orphan" });
    const recallTool = await harness.executeTool("hindsight_recall", { query: "anything" }, { agentId: AGENT_UNMAPPED, runId: "run-o", companyId: COMPANY, projectId: PROJECT });
    const retainTool = await harness.executeTool("hindsight_retain", { content: "should not land" }, { agentId: AGENT_UNMAPPED, runId: "run-o", companyId: COMPANY, projectId: PROJECT });

    // No HTTP call at all: neither recall nor retain reached the service.
    assert.equal(hindsight.calls.length, 0);
    assert.equal(recallTool.content, "No memories available for this agent.");
    assert.ok(String(retainTool.content).includes("not mapped to a bank"));

    // The skips are visible as warnings in the plugin log.
    const warnings = harness.logs.filter((entry) => entry.level === "warn");
    assert.equal(warnings.filter((entry) => entry.message.includes("not mapped to a bank")).length, 2);
  });

  it("an external-channel agent resolves to shop-public, never fleet-bbq", async () => {
    const hindsight = mockHindsight();
    const harness = createTestHarness({
      manifest: manifest as PaperclipPluginManifestV1,
      config: { hindsightApiUrl: API_URL },
    });
    harness.seed({
      agents: [agent({ id: AGENT_SHOP, name: "bbq-customer-support", bankId: "shop-public" })],
      issues: [issue({ id: "issue-shop", title: "Customer delivery window", assigneeAgentId: AGENT_SHOP })],
      issueComments: [
        comment({ id: "comment-shop", issueId: "issue-shop", body: "customer asks about delivery", authorUserId: "user-external" }),
      ],
    });
    const plugin = createHindsightPlugin({ fetchImpl: hindsight.fetch });
    await plugin.definition.setup(harness.ctx);

    await harness.emit("agent.run.started", { agentId: AGENT_SHOP, runId: "run-s", issueId: "issue-shop" }, { companyId: COMPANY, entityId: "issue-shop" });
    await harness.emit("issue.comment.created", { commentId: "comment-shop", agentId: null }, { companyId: COMPANY, entityId: "issue-shop" });
    await harness.executeTool("hindsight_retain", { content: "delivery window preference" }, { agentId: AGENT_SHOP, runId: "run-s", companyId: COMPANY, projectId: PROJECT });

    const touchedBanks = hindsight.calls.map((call) => currentBankId(call.path));
    assert.ok(touchedBanks.length > 0);
    assert.ok(touchedBanks.every((bank) => bank === "shop-public"), touchedBanks.join(","));
    assert.ok(!hindsight.banks.has("fleet-bbq"));
    assert.ok(!hindsight.calls.some((call) => currentBankId(call.path) === "fleet-bbq"));
  });

  it("honors the config map when the card carries no bank", async () => {
    const hindsight = mockHindsight();
    const harness = createTestHarness({
      manifest: manifest as PaperclipPluginManifestV1,
      config: { hindsightApiUrl: API_URL, bankByAgentId: { [AGENT_UNMAPPED]: "fleet-work" } },
    });
    harness.seed({
      agents: [agent({ id: AGENT_UNMAPPED, name: "work-agent" })],
      issues: [issue({ id: "issue-work", title: "Weekly report", assigneeAgentId: AGENT_UNMAPPED })],
      issueComments: [
        comment({ id: "comment-work", issueId: "issue-work", body: "report ready", authorAgentId: AGENT_UNMAPPED }),
      ],
    });
    const plugin = createHindsightPlugin({ fetchImpl: hindsight.fetch });
    await plugin.definition.setup(harness.ctx);

    await harness.emit("issue.comment.created", { commentId: "comment-work", agentId: AGENT_UNMAPPED }, { companyId: COMPANY, entityId: "issue-work" });
    await harness.executeTool("hindsight_retain", { content: "report cadence" }, { agentId: AGENT_UNMAPPED, runId: "run-w", companyId: COMPANY, projectId: PROJECT });

    const retains = hindsight.calls.filter((call) => call.path.endsWith("/memories") && call.method === "POST");
    assert.equal(retains.length, 2);
    assert.deepEqual(
      retains.map((call) => currentBankId(call.path)),
      ["fleet-work", "fleet-work"],
    );
    assert.equal(retainMetadata(retains[0]!)["agentName"], "work-agent");
  });

  it("recall results are cached per run and replayed by the tool", async () => {
    const hindsight = mockHindsight();
    // Seed one memory so recall has a result to cache.
    hindsight.banks.set("adm", [{ content: "cached memory", metadata: {} }]);
    const harness = createTestHarness({
      manifest: manifest as PaperclipPluginManifestV1,
      config: { hindsightApiUrl: API_URL },
    });
    harness.seed({
      agents: [agent({ id: AGENT_ADM, name: "ops-agent", bankId: "adm" })],
      issues: [issue({ id: "issue-cache", title: "Cache probe", assigneeAgentId: AGENT_ADM })],
    });
    const plugin = createHindsightPlugin({ fetchImpl: hindsight.fetch });
    await plugin.definition.setup(harness.ctx);

    await harness.emit("agent.run.started", { agentId: AGENT_ADM, runId: "run-c", issueId: "issue-cache" }, { companyId: COMPANY, entityId: "issue-cache" });
    const first = await harness.executeTool("hindsight_recall", { query: "cache" }, { agentId: AGENT_ADM, runId: "run-c", companyId: COMPANY, projectId: PROJECT });
    const second = await harness.executeTool("hindsight_recall", { query: "cache" }, { agentId: AGENT_ADM, runId: "run-c", companyId: COMPANY, projectId: PROJECT });

    // run-start recall (1 call) + first tool call (cache miss → 1 call);
    // the second tool call replays the cache without a request.
    const recalls = hindsight.calls.filter((call) => call.path.endsWith("/memories/recall"));
    assert.equal(recalls.length, 1);
    assert.ok(first.content!.includes("cached memory"));
    assert.equal(first.content, second.content);
  });

  it("autoRetain=false stops comment retention but keeps the tools", async () => {
    const hindsight = mockHindsight();
    const harness = createTestHarness({
      manifest: manifest as PaperclipPluginManifestV1,
      config: { hindsightApiUrl: API_URL, autoRetain: false },
    });
    harness.seed({
      agents: [agent({ id: AGENT_BBQ, name: "bbq-grill", bankId: "fleet-bbq" })],
      issues: [issue({ id: "issue-off", title: "Quiet mode", assigneeAgentId: AGENT_BBQ })],
      issueComments: [
        comment({ id: "comment-off", issueId: "issue-off", body: "not retained", authorAgentId: AGENT_BBQ }),
      ],
    });
    const plugin = createHindsightPlugin({ fetchImpl: hindsight.fetch });
    await plugin.definition.setup(harness.ctx);

    await harness.emit("issue.comment.created", { commentId: "comment-off", agentId: AGENT_BBQ }, { companyId: COMPANY, entityId: "issue-off" });
    await harness.executeTool("hindsight_retain", { content: "tool still works" }, { agentId: AGENT_BBQ, runId: "run-off", companyId: COMPANY, projectId: PROJECT });

    const retains = hindsight.calls.filter((call) => call.path.endsWith("/memories") && call.method === "POST");
    assert.equal(retains.length, 1); // only the tool retain
    assert.equal(currentBankId(retains[0]!.path), "fleet-bbq");
  });

  it("enabledAgentIds still gates everything", async () => {
    const hindsight = mockHindsight();
    const harness = createTestHarness({
      manifest: manifest as PaperclipPluginManifestV1,
      config: { hindsightApiUrl: API_URL, enabledAgentIds: [AGENT_ADM] },
    });
    harness.seed({
      agents: [agent({ id: AGENT_BBQ, name: "bbq-grill", bankId: "fleet-bbq" })],
      issues: [issue({ id: "issue-gate", title: "Gate", assigneeAgentId: AGENT_BBQ })],
      issueComments: [
        comment({ id: "comment-gate", issueId: "issue-gate", body: "gated", authorAgentId: AGENT_BBQ }),
      ],
    });
    const plugin = createHindsightPlugin({ fetchImpl: hindsight.fetch });
    await plugin.definition.setup(harness.ctx);

    await harness.emit("agent.run.started", { agentId: AGENT_BBQ, runId: "run-g", issueId: "issue-gate" }, { companyId: COMPANY, entityId: "issue-gate" });
    await harness.emit("issue.comment.created", { commentId: "comment-gate", agentId: AGENT_BBQ }, { companyId: COMPANY, entityId: "issue-gate" });
    await harness.executeTool("hindsight_retain", { content: "gated" }, { agentId: AGENT_BBQ, runId: "run-g", companyId: COMPANY, projectId: PROJECT });

    assert.equal(hindsight.calls.length, 0);
  });
});

describe("manifest", () => {
  it("replaces the upstream id and versions the fork", () => {
    assert.equal(manifest.id, "paperclip-plugin-hindsight");
    assert.equal(manifest.version, "0.3.0-myrmidon.1");
    assert.ok(manifest.capabilities.includes("agents.read"));
    assert.ok(manifest.capabilities.includes("events.subscribe"));
    assert.ok(manifest.capabilities.includes("agent.tools.register"));
  });

  it("documents the bank map config field", () => {
    const properties = manifest.instanceConfigSchema?.["properties"] as Record<string, unknown>;
    assert.ok(properties["bankByAgentId"]);
    assert.ok(!properties["bankId"]);
    assert.ok(!properties["dynamicBankId"]);
    assert.ok(!properties["bankGranularity"]);
  });
});
