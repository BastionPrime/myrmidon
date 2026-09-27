import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  companySecretBindings,
  companySecretProviderConfigs,
  companySecretVersions,
  companySecrets,
  createDb,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import { redactEventPayload, redactSensitiveText } from "../redaction.js";
import { agentService } from "../services/agents.js";
import { projectSafeChatPublicationText } from "../services/chat-publication-projection.js";
import { compactRunLogChunk } from "../services/heartbeat.js";
import { mergeHeartbeatRunResultJson } from "../services/heartbeat-run-summary.js";
import { issueService } from "../services/issues.js";
import { secretService } from "../services/secrets.js";
import {
  maskSecretsInText,
  redactUrlCredentials,
  registerSecretValues,
  resetSecretMasking,
} from "./secret-masking.js";

// Obviously fake values: nothing here is a real credential.
const AGENT_SECRET = "fake-agent-secret-value-0001";

describe("myrmidon(S5) masking without a database", () => {
  const saved = process.env.BETTER_AUTH_SECRET;

  beforeEach(() => resetSecretMasking());
  afterEach(() => {
    if (saved === undefined) delete process.env.BETTER_AUTH_SECRET;
    else process.env.BETTER_AUTH_SECRET = saved;
    resetSecretMasking();
  });

  it("masks the password of a postgres URL in run output", () => {
    const line = "connecting to postgres://user:pass@db.example.com/db failed";
    expect(redactSensitiveText(line)).toBe("connecting to postgres://user:****@db.example.com/db failed");
    expect(compactRunLogChunk(line)).not.toContain("user:pass@");
  });

  it("masks token-only userinfo in git URLs", () => {
    expect(redactUrlCredentials("git clone https://fakeTokenValue0123456789@git.example.com/org/repo.git")).toBe(
      "git clone https://****@git.example.com/org/repo.git",
    );
    expect(redactUrlCredentials("see https://example.com/a@b")).toBe("see https://example.com/a@b");
  });

  it("masks server secrets from the S2 list by value", () => {
    process.env.BETTER_AUTH_SECRET = "fake-better-auth-secret-value";
    resetSecretMasking();
    expect(maskSecretsInText("leak: fake-better-auth-secret-value.")).toBe("leak: [secret:BETTER_AUTH_SECRET].");
  });

  it("short values (under 8 characters) do not damage ordinary text", () => {
    registerSecretValues({ SHORT_A: "abc", SHORT_B: "token12", LONG: "fake-long-value-1" }, [
      "SHORT_A",
      "SHORT_B",
      "LONG",
    ]);
    const text = "abc is a word, token12 too; fake-long-value-1 is not";
    expect(maskSecretsInText(text)).toBe("abc is a word, token12 too; [secret:LONG] is not");
  });

  it("plain (non-secret) config values are not registered", () => {
    registerSecretValues({ PLAIN_SETTING: "ordinary-config-value" }, []);
    expect(maskSecretsInText("ordinary-config-value")).toBe("ordinary-config-value");
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("myrmidon(S5) agent secret values are masked where text is stored or sent", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `myrmidon-secret-masking-${randomUUID()}`);
  let companyId = "";
  let agentId = "";

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("myrmidon-secret-masking-");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 30_000);

  beforeEach(async () => {
    resetSecretMasking();
    companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "company-a",
      issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const secret = await secretService(db).create(companyId, {
      name: `tool-token-${randomUUID()}`,
      provider: "local_encrypted",
      value: AGENT_SECRET,
    });
    const agent = await agentService(db).create(companyId, {
      name: "agent-a",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {
        env: { TOOL_TOKEN: { type: "secret_ref", secretId: secret.id, version: "latest" } },
      },
      runtimeConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });
    agentId = agent.id;
    // The run resolves the agent's secrets exactly like heartbeat does.
    const { config } = await secretService(db).resolveAdapterConfigForRuntime(companyId, agent.adapterConfig, {
      consumerType: "agent",
      consumerId: agent.id,
      actorType: "agent",
      actorId: agent.id,
    });
    expect((config.env as Record<string, string>).TOOL_TOKEN).toBe(AGENT_SECRET);
  });

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(activityLog);
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(companySecretProviderConfigs);
    await db.delete(agents);
    await db.delete(companies);
    resetSecretMasking();
  });

  afterAll(async () => {
    await stopDb?.();
    if (previousKeyFile === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    rmSync(secretsTmpDir, { recursive: true, force: true });
  });

  it("run output: stored log chunk, event and result carry the mask", () => {
    const output = `the token is ${AGENT_SECRET}\n`;
    expect(compactRunLogChunk(output)).toBe("the token is [secret:TOOL_TOKEN]\n");
    expect(redactEventPayload({ message: output, nested: [{ text: output }] })).toEqual({
      message: "the token is [secret:TOOL_TOKEN]\n",
      nested: [{ text: "the token is [secret:TOOL_TOKEN]\n" }],
    });
    const result = mergeHeartbeatRunResultJson({ stdout: output }, `done, used ${AGENT_SECRET}`);
    expect(JSON.stringify(result)).not.toContain(AGENT_SECRET);
    expect(result).toMatchObject({ stdout: "the token is [secret:TOOL_TOKEN]\n", summary: "done, used [secret:TOOL_TOKEN]" });
  });

  it("agent comment is stored with the mask", async () => {
    const [issue] = await db
      .insert(issues)
      .values({ companyId, title: "issue-a", status: "todo", priority: "medium" })
      .returning();
    await issueService(db).addComment(issue!.id, `here it is: ${AGENT_SECRET}`, { agentId });
    const stored = await db.select().from(issueComments).where(eq(issueComments.issueId, issue!.id));
    expect(stored).toHaveLength(1);
    expect(stored[0]!.body).toBe("here it is: [secret:TOOL_TOKEN]");
  });

  it("outgoing chat message leaves with the mask", () => {
    // The vendor projection further redacts the credential-like name itself.
    const sent = projectSafeChatPublicationText(`reply: ${AGENT_SECRET}`);
    expect(sent).not.toContain(AGENT_SECRET);
    expect(sent).toMatch(/^reply: \[secret:/);
  });
});
