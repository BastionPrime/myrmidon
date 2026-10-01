// myrmidon(WORKSPACE-HYGIENE) part C: importing the store must not touch the
// database module at import time.
//
// The server startup test mocks `@paperclipai/db` with only the exports it
// needs. The store read `executionWorkspaces` while the module was being
// imported (a column list built at module scope), so importing the server —
// which now imports this module from the scheduler tick — crashed the startup
// test with "No 'executionWorkspaces' export is defined on the mock". The
// columns are built per call now; this test keeps that true.

import { describe, expect, it, vi } from "vitest";

vi.mock("@paperclipai/db", () => ({}));

describe("myrmidon(WORKSPACE-HYGIENE): the store under a partial db mock", () => {
  it("imports and constructs without reading the mocked tables at import time", async () => {
    const { createDbWorkspaceHygieneStore } = await import("./store.js");
    expect(() => createDbWorkspaceHygieneStore({} as never)).not.toThrow();
  });
});