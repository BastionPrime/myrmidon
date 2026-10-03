// myrmidon(X9a): unit coverage for `@<alias>` addressing in the bridged
// Telegram chat. The DB read is a single company-scoped select, so a fake
// db with one canned select result is enough (same pattern as
// bot-containers/agents-query.myrmidon.test.ts: the where-condition is
// rendered through PgDialect to prove company scoping). The agent-card
// contract (aliases in metadata/adapterConfig, name and title fallbacks,
// unknown-alias candidates) is what these tests pin down.
import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { type Db } from "@paperclipai/db";
import {
  consumeLeadingMention,
  findMention,
  readTelegramAliases,
  resolveTelegramAddressee,
} from "./addressing.js";

interface AgentRow {
  id: string;
  name: string;
  title: string | null;
  metadata: unknown;
  adapterConfig: unknown;
}

/**
 * Fake db: `db.select({...}).from(agents).where(...)` resolves to the
 * company's rows. Everything else throws — the module must not touch the
 * database beyond that one select.
 */
function fakeDb(rowsByCompany: Record<string, AgentRow[]>) {
  const captured: { fields?: Record<string, unknown>; where?: SQL } = {};
  const chain = {
    select(fields: Record<string, unknown>) {
      captured.fields = fields;
      return chain;
    },
    from() {
      return chain;
    },
    where(condition: SQL) {
      captured.where = condition;
      const rendered = new PgDialect().sqlToQuery(condition);
      const companyId = rendered.params[0];
      const rows =
        (typeof companyId === "string" && rowsByCompany[companyId]) ?? [];
      return Promise.resolve(rows);
    },
  };
  return { db: chain as unknown as Db, captured };
}

const COMPANY_A = "company-a";
const COMPANY_B = "company-b";

const AGENT_A = {
  id: "agent-a-id",
  name: "Agent A",
  title: "Support Lead",
  metadata: { telegramAliases: ["support", "helpdesk"] },
  adapterConfig: {},
};
const AGENT_B = {
  id: "agent-b-id",
  name: "Agent B",
  title: null,
  metadata: null,
  adapterConfig: { telegramAliases: ["writer"] },
};
const AGENT_C = {
  id: "agent-c-id",
  name: "Agent_C",
  title: "Analyst",
  metadata: null,
  adapterConfig: null,
};

const dbHandle = fakeDb({
  [COMPANY_A]: [AGENT_A, AGENT_B, AGENT_C],
  [COMPANY_B]: [
    {
      id: "agent-other-company",
      name: "Agent A",
      title: "Support Lead",
      metadata: { telegramAliases: ["support"] },
      adapterConfig: {},
    },
  ],
});
const db = dbHandle.db;

describe("myrmidon(X9a) readTelegramAliases", () => {
  it("reads aliases from a card object", () => {
    expect(readTelegramAliases({ telegramAliases: ["a", "B"] })).toEqual([
      "a",
      "b",
    ]);
  });

  it("normalizes: trims, lower-cases, dedupes, drops non-strings", () => {
    expect(
      readTelegramAliases({ telegramAliases: [" A ", "a", 42, null, "b"] }),
    ).toEqual(["a", "b"]);
  });

  it("returns [] for missing, non-array, or non-object cards", () => {
    expect(readTelegramAliases(null)).toEqual([]);
    expect(readTelegramAliases(undefined)).toEqual([]);
    expect(readTelegramAliases("telegramAliases")).toEqual([]);
    expect(readTelegramAliases({ telegramAliases: "support" })).toEqual([]);
    expect(readTelegramAliases({})).toEqual([]);
  });
});

describe("myrmidon(X9a) findMention / consumeLeadingMention", () => {
  it("finds a leading mention and marks it leading", () => {
    expect(findMention("@support please help")).toEqual({
      handle: "support",
      leading: true,
    });
  });

  it("allows leading whitespace before a leading mention", () => {
    expect(findMention("  @support hi")).toEqual({
      handle: "support",
      leading: true,
    });
  });

  it("finds a mid-text mention and marks it not leading", () => {
    expect(findMention("hey @writer, draft this")).toEqual({
      handle: "writer",
      leading: false,
    });
  });

  it("stops the handle at punctuation", () => {
    expect(findMention("ping @support, please")).toEqual({
      handle: "support",
      leading: false,
    });
  });

  it("returns null without an @ or for a bare @ or an email", () => {
    expect(findMention("no mention here")).toBeNull();
    expect(findMention("@")).toBeNull();
    expect(findMention("email me at a@b")).toBeNull();
  });

  it("consumes a leading mention, leaving the rest trimmed", () => {
    expect(consumeLeadingMention("@support please help", "support")).toBe(
      "please help",
    );
  });
});

describe("myrmidon(X9a) resolveTelegramAddressee", () => {
  it("scopes the select to the company and reads the card fields", async () => {
    const { db, captured } = fakeDb({ [COMPANY_A]: [AGENT_A] });
    await resolveTelegramAddressee(db, COMPANY_A, "@support hi", null);
    const rendered = new PgDialect().sqlToQuery(captured.where!);
    expect(rendered.sql).toMatch(/"company_id" = \$1/);
    expect(rendered.params).toEqual([COMPANY_A]);
    expect(Object.keys(captured.fields ?? {}).sort()).toEqual([
      "adapterConfig",
      "id",
      "metadata",
      "name",
      "title",
    ]);
  });

  it("resolves a leading alias mention from metadata and consumes the text", async () => {
    const result = await resolveTelegramAddressee(
      db,
      COMPANY_A,
      "@support what is the status?",
      "agent-b-id",
    );
    expect(result.addressee).toEqual({
      agentId: "agent-a-id",
      displayName: "Agent A",
    });
    expect(result.consumedText).toBe("what is the status?");
    expect(result.candidates).toContain("support");
    expect(result.candidates).toContain("writer");
  });

  it("resolves a mid-text alias mention without consuming text", async () => {
    const result = await resolveTelegramAddressee(
      db,
      COMPANY_A,
      "Can you ask @writer to draft it?",
      "agent-a-id",
    );
    expect(result.addressee).toEqual({
      agentId: "agent-b-id",
      displayName: "Agent B",
    });
    expect(result.consumedText).toBeNull();
  });

  it("resolves an alias stored in adapterConfig", async () => {
    const result = await resolveTelegramAddressee(
      db,
      COMPANY_A,
      "@writer hello",
      null,
    );
    expect(result.addressee?.agentId).toBe("agent-b-id");
  });

  it("resolves by agent name when the mention is not an alias", async () => {
    const result = await resolveTelegramAddressee(
      db,
      COMPANY_A,
      "@agent_c hello",
      "agent-a-id",
    );
    expect(result.addressee).toEqual({
      agentId: "agent-c-id",
      displayName: "Agent_C",
    });
  });

  it("resolves by title", async () => {
    const result = await resolveTelegramAddressee(
      db,
      COMPANY_A,
      "@analyst hello",
      "agent-a-id",
    );
    expect(result.addressee).toEqual({
      agentId: "agent-c-id",
      displayName: "Agent_C",
    });
  });

  it("prefers an exact alias over a name handle of another agent", async () => {
    // Both rows match the handle "agent a": one via an explicit alias,
    // one via its lower-cased name. The alias must win.
    const dbBoth = fakeDb({
      [COMPANY_A]: [
        { ...AGENT_A, metadata: { telegramAliases: ["agent_a"] } },
        { ...AGENT_C, name: "Agent A", metadata: null, adapterConfig: null },
      ],
    }).db;
    const result = await resolveTelegramAddressee(
      dbBoth,
      COMPANY_A,
      "@agent_a now",
      null,
    );
    expect(result.addressee?.agentId).toBe("agent-a-id");
  });

  it("an agent of another company does not match", async () => {
    // company-b has an agent with the same name/title/aliases as
    // company-a's Agent A; resolving for company-a must ignore it.
    const dbOnlyB = fakeDb({ [COMPANY_B]: [AGENT_A] }).db;
    const result = await resolveTelegramAddressee(
      dbOnlyB,
      COMPANY_A,
      "@support hello",
      "agent-a-id",
    );
    expect(result.addressee).toBeNull();
    expect(result.candidates).toEqual([]);
  });

  it("resolves within the right company when both are populated", async () => {
    const result = await resolveTelegramAddressee(
      db,
      COMPANY_B,
      "@support hello",
      null,
    );
    expect(result.addressee?.agentId).toBe("agent-other-company");
  });

  it("missing or empty aliases fall back to name and title", async () => {
    const dbNoAliases = fakeDb({
      [COMPANY_A]: [
        {
          id: "agent-x",
          name: "Agent_X",
          title: "Ops",
          metadata: { telegramAliases: [] },
          adapterConfig: { telegramAliases: [] },
        },
      ],
    }).db;
    const byName = await resolveTelegramAddressee(
      dbNoAliases,
      COMPANY_A,
      "@agent_x hi",
      null,
    );
    expect(byName.addressee?.agentId).toBe("agent-x");
    const byTitle = await resolveTelegramAddressee(
      dbNoAliases,
      COMPANY_A,
      "@ops hi",
      null,
    );
    expect(byTitle.addressee?.agentId).toBe("agent-x");
  });

  it("an unknown alias yields null plus the candidate list for the hint", async () => {
    const result = await resolveTelegramAddressee(
      db,
      COMPANY_A,
      "@unknown-alias hello",
      "agent-a-id",
    );
    expect(result.addressee).toBeNull();
    expect(result.consumedText).toBeNull();
    // Name, aliases, and title handles of the company's agents.
    expect(result.candidates.sort()).toEqual(
      [
        "agent a",
        "agent b",
        "agent_c",
        "support",
        "helpdesk",
        "writer",
        "support lead",
        "analyst",
      ].sort(),
    );
  });

  it("text without a mention resolves to null with no candidates", async () => {
    const result = await resolveTelegramAddressee(
      db,
      COMPANY_A,
      "just a plain message",
      "agent-a-id",
    );
    expect(result.addressee).toBeNull();
    expect(result.candidates).toEqual([]);
    expect(result.consumedText).toBeNull();
  });

  it("consumed text of a leading mention keeps the rest intact", async () => {
    const result = await resolveTelegramAddressee(
      db,
      COMPANY_A,
      "  @helpdesk  status please",
      null,
    );
    expect(result.addressee?.agentId).toBe("agent-a-id");
    expect(result.consumedText).toBe("status please");
  });
});
