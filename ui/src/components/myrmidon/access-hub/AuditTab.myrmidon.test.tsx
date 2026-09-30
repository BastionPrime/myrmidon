// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuditTabView } from "./AuditTab";
import type { AccessAuditEntry } from "./accessHubApi";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const JOURNAL_VALUE = "correct-horse-battery-staple";

function entry(overrides: Partial<AccessAuditEntry> = {}): AccessAuditEntry {
  return {
    at: "2026-09-25T08:30:00.000Z",
    actor: "operator@example",
    action: "rotate",
    secretName: "Deploy key",
    targetName: null,
    version: 4,
    ...overrides,
  } as AccessAuditEntry;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
});

function renderTab(entries: AccessAuditEntry[], limit?: number) {
  flushSync(() => root.render(<AuditTabView entries={entries} limit={limit} />));
}

describe("AuditTabView", () => {
  it("lists the journal with who, what, when and which version", () => {
    renderTab([entry(), entry({ at: "2026-09-24T08:00:00.000Z", action: "grant", targetName: "Release bot", version: null })]);

    const headers = Array.from(container.querySelectorAll("th")).map((cell) => cell.textContent);
    expect(headers).toEqual(["When", "Actor", "Action", "Access", "Target", "Version"]);

    const rows = container.querySelectorAll('[data-testid="access-hub-audit-row"]');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("2026-09-25 08:30Z");
    expect(rows[0].textContent).toContain("operator@example");
    expect(rows[0].textContent).toContain("rotate");
    expect(rows[0].textContent).toContain("Deploy key");
    expect(rows[0].textContent).toContain("v4");
    expect(rows[1].textContent).toContain("Release bot");
    expect(rows[1].textContent).toContain("—");
  });

  it("shows the newest entries first and honours the limit", () => {
    renderTab(
      [
        entry({ at: "2026-09-20T00:00:00.000Z", action: "oldest" }),
        entry({ at: "2026-09-25T00:00:00.000Z", action: "newest" }),
        entry({ at: "2026-09-22T00:00:00.000Z", action: "middle" }),
      ],
      2,
    );

    const rows = Array.from(container.querySelectorAll('[data-testid="access-hub-audit-row"]'));
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("newest");
    expect(rows[1].textContent).toContain("middle");
  });

  it("never renders a journal value", () => {
    renderTab([entry({ value: JOURNAL_VALUE, secretValue: JOURNAL_VALUE } as Partial<AccessAuditEntry>)]);

    expect(container.textContent).not.toContain(JOURNAL_VALUE);
    expect(container.innerHTML).not.toContain(JOURNAL_VALUE);
  });

  it("explains an empty journal", () => {
    renderTab([]);

    expect(container.textContent).toContain("Nothing in the journal yet");
  });

  it("surfaces a load failure", () => {
    flushSync(() => root.render(<AuditTabView entries={[]} error="Journal unavailable" />));

    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Journal unavailable");
  });
});