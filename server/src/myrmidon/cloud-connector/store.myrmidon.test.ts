// myrmidon(CLOUD-CONNECTOR): store tests.
//
// The connector state is read back defensively on every call: a malformed
// row must never crash a request, and the journal stays bounded. These tests
// cover the parsing, the journal cap and the key-preservation helper that
// keeps our state alive across vendor writes of instance_settings.general.

import { describe, expect, it } from "vitest";
import type { CloudJournalEntry } from "@paperclipai/shared/myrmidon-cloud-connector";
import {
  appendJournal,
  CLOUD_CONNECTOR_GENERAL_KEY,
  emptyCloudConnectorDocument,
  memoryCloudConnectorStore,
  parseCloudConnectorDocument,
  preserveCloudConnectorGeneralKey,
} from "./store.js";

const ACCOUNT = {
  id: "account-1",
  providerId: "onedrive",
  companyId: "company-a",
  displayName: "Owner OneDrive",
  tokenRef: "secret/onedrive",
  scopes: ["Files.ReadWrite"],
  connectedAt: "2026-01-01T00:00:00.000Z",
  connectedBy: "board",
};

const ROOT = {
  id: "root-1",
  providerId: "onedrive",
  companyId: "company-a",
  name: "work",
  kind: "own",
  description: "",
  driveId: null,
  itemId: null,
  folder: "Agents/agent-a",
  personalForAgentId: "agent-a",
  createdAt: "2026-01-01T00:00:00.000Z",
};

const GRANT = {
  id: "grant-1",
  rootId: "root-1",
  targetKind: "agent",
  agentId: "agent-a",
  caste: null,
  mode: "rw",
  createdAt: "2026-01-01T00:00:00.000Z",
  createdBy: "board",
};

function entry(index: number): CloudJournalEntry {
  return {
    id: `entry-${index}`,
    at: "2026-01-01T00:00:00.000Z",
    actor: "agent-a",
    tool: "cloud_list",
    rootId: "root-1",
    rootName: "work",
    path: "",
    ok: true,
    detail: null,
  };
}

describe("parseCloudConnectorDocument", () => {
  it("reads a well-formed document", () => {
    const document = parseCloudConnectorDocument({
      version: 1,
      accounts: [ACCOUNT],
      roots: [ROOT],
      grants: [GRANT],
      journal: [entry(1)],
    });
    expect(document.accounts).toHaveLength(1);
    expect(document.roots[0]).toMatchObject({ name: "work", kind: "own" });
    expect(document.grants[0]).toMatchObject({ mode: "rw", targetKind: "agent" });
    expect(document.journal).toHaveLength(1);
  });

  it("reads anything malformed as an empty document", () => {
    expect(parseCloudConnectorDocument(null).roots).toEqual([]);
    expect(parseCloudConnectorDocument("nope").accounts).toEqual([]);
  });

  it("drops only the broken entries and keeps the good ones", () => {
    const document = parseCloudConnectorDocument({
      accounts: [ACCOUNT, { id: "broken" }],
      roots: [ROOT, { id: "r2", name: "x", kind: "nonsense" }],
      grants: [GRANT, { id: "g2", rootId: "r1", targetKind: "agent", mode: "write" }],
      journal: [entry(1), { id: "j2" }],
    });
    expect(document.accounts).toHaveLength(1);
    expect(document.roots).toHaveLength(1);
    expect(document.grants).toHaveLength(1);
    expect(document.journal).toHaveLength(1);
  });
});

describe("appendJournal", () => {
  it("puts the newest entry first and caps the list", () => {
    let document = emptyCloudConnectorDocument();
    for (let index = 0; index < 205; index += 1) {
      document = appendJournal(document, entry(index));
    }
    expect(document.journal).toHaveLength(200);
    expect(document.journal[0]!.id).toBe("entry-204");
    expect(document.journal.at(-1)!.id).toBe("entry-5");
  });
});

describe("preserveCloudConnectorGeneralKey", () => {
  it("keeps our key and drops the vendor keys", () => {
    const stored = { someVendorSetting: true, [CLOUD_CONNECTOR_GENERAL_KEY]: { version: 1 } };
    expect(preserveCloudConnectorGeneralKey(stored)).toEqual({ [CLOUD_CONNECTOR_GENERAL_KEY]: { version: 1 } });
  });

  it("returns nothing when the key is absent or the value is not an object", () => {
    expect(preserveCloudConnectorGeneralKey({})).toEqual({});
    expect(preserveCloudConnectorGeneralKey(null)).toEqual({});
  });
});

describe("memoryCloudConnectorStore", () => {
  it("keeps the document between reads and writes", async () => {
    const store = memoryCloudConnectorStore();
    await store.mutate((current) => ({ next: { ...current, accounts: [ACCOUNT] as never }, result: null }));
    expect((await store.read()).accounts).toHaveLength(1);
  });

  it("keeps the stored value when the change returns null", async () => {
    const store = memoryCloudConnectorStore();
    const { changed } = await store.mutate(() => ({ next: null, result: "kept" }));
    expect(changed).toBe(false);
    expect((await store.read()).accounts).toEqual([]);
  });
});