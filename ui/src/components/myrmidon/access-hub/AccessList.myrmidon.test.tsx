// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccessListView } from "./AccessList";
import {
  ALL_GRANTEES,
  EMPTY_ACCESS_FILTERS,
  type AccessHost,
  type AccessListFilters,
  type AccessRecord,
} from "./accessHubApi";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const HOSTS: AccessHost[] = [
  { hostId: "host-a", name: "edge-1" },
  { hostId: "host-b", name: "edge-2" },
];

const AGENTS = [
  { id: "agent-a", name: "Release bot" },
  { id: "agent-b", name: "Build bot" },
];

function record(overrides: Partial<AccessRecord> = {}): AccessRecord {
  return {
    secretId: "secret-a",
    name: "Deploy key",
    key: "DEPLOY_KEY",
    kind: "ssh_key",
    status: "active",
    latestVersion: 3,
    createdAt: "2026-09-20T10:00:00.000Z",
    lastRotatedAt: "2026-09-25T08:30:00.000Z",
    bindings: [
      { targetType: "agent", targetId: "agent-a", targetName: "Release bot", configPath: null },
      {
        targetType: "host",
        targetId: "host-a",
        targetName: "edge-1",
        configPath: "/srv/app/.env",
      },
    ],
    hostRefs: ["host-a"],
    fingerprint: "SHA256:abc",
    ...overrides,
  };
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

function renderList(overrides: {
  records?: AccessRecord[];
  filters?: AccessListFilters;
  onFiltersChange?: (next: AccessListFilters) => void;
  onSelect?: (secretId: string) => void;
}) {
  flushSync(() =>
    root.render(
      <AccessListView
        records={overrides.records ?? [record()]}
        hosts={HOSTS}
        agents={AGENTS}
        filters={overrides.filters ?? EMPTY_ACCESS_FILTERS}
        onFiltersChange={overrides.onFiltersChange ?? (() => undefined)}
        onSelect={overrides.onSelect ?? (() => undefined)}
        onCreate={() => undefined}
      />,
    ),
  );
}

function setSelectValue(element: HTMLSelectElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(element, value);
  flushSync(() => element.dispatchEvent(new Event("change", { bubbles: true })));
}

function setInputValue(element: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
  flushSync(() => element.dispatchEvent(new Event("input", { bubbles: true })));
}

describe("AccessListView", () => {
  it("renders one row per access with type, grantees, usage, dates and version", () => {
    renderList({ records: [record(), record({ secretId: "secret-b", name: "Registry token", kind: "token" })] });

    expect(container.querySelectorAll('[data-testid="access-hub-row"]')).toHaveLength(2);
    const headers = Array.from(container.querySelectorAll("th")).map((cell) => cell.textContent);
    expect(headers).toEqual(["Name", "Type", "Granted to", "Used by", "Created", "Rotated", "Version"]);

    const firstRow = container.querySelector('[data-testid="access-hub-row"]')!;
    expect(firstRow.textContent).toContain("Deploy key");
    expect(firstRow.textContent).toContain("SSH key");
    expect(firstRow.textContent).toContain("Release bot");
    expect(firstRow.textContent).toContain("edge-1");
    expect(firstRow.textContent).toContain("2026-09-20 10:00Z");
    expect(firstRow.textContent).toContain("2026-09-25 08:30Z");
    expect(firstRow.textContent).toContain("v3");
  });

  it("marks accesses nobody holds and nothing uses", () => {
    renderList({ records: [record({ bindings: [], hostRefs: [], lastRotatedAt: null })] });

    const row = container.querySelector('[data-testid="access-hub-row"]')!;
    expect(row.textContent).toContain("Nobody");
    expect(row.textContent).toContain("Unused");
    expect(row.textContent).toContain("—");
  });

  it("opens the card of the clicked access", () => {
    const onSelect = vi.fn();
    renderList({ onSelect });

    const nameButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Deploy key",
    )!;
    flushSync(() => nameButton.click());

    expect(onSelect).toHaveBeenCalledWith("secret-a");
  });

  it("reports the type filter", () => {
    const onFiltersChange = vi.fn();
    renderList({ onFiltersChange });

    setSelectValue(container.querySelector<HTMLSelectElement>('[aria-label="Filter by type"]')!, "password");

    expect(onFiltersChange).toHaveBeenCalledWith({ ...EMPTY_ACCESS_FILTERS, kind: "password" });
  });

  it("offers every agent as a filter and reports the picked one", () => {
    const onFiltersChange = vi.fn();
    renderList({ onFiltersChange });

    const agentSelect = container.querySelector<HTMLSelectElement>('[aria-label="Filter by agent"]')!;
    expect(Array.from(agentSelect.options).map((option) => option.value)).toEqual([
      ALL_GRANTEES,
      "agent-a",
      "agent-b",
    ]);

    setSelectValue(agentSelect, "agent-b");
    expect(onFiltersChange).toHaveBeenCalledWith({ ...EMPTY_ACCESS_FILTERS, agent: "agent-b" });
  });

  it("reports the search term", () => {
    const onFiltersChange = vi.fn();
    renderList({ onFiltersChange });

    setInputValue(container.querySelector<HTMLInputElement>('[aria-label="Search accesses"]')!, "deploy");

    expect(onFiltersChange).toHaveBeenCalledWith({ ...EMPTY_ACCESS_FILTERS, search: "deploy" });
  });

  it("shows the empty state when a filter matches nothing", () => {
    renderList({ records: [] });

    expect(container.textContent).toContain("No accesses match this view");
    expect(container.querySelector('[data-testid="access-hub-row"]')).toBeNull();
  });

  it("surfaces a load failure", () => {
    flushSync(() =>
      root.render(
        <AccessListView
          records={[]}
          hosts={HOSTS}
          agents={AGENTS}
          filters={EMPTY_ACCESS_FILTERS}
          error="Access hub is unavailable"
          onFiltersChange={() => undefined}
          onSelect={() => undefined}
          onCreate={() => undefined}
        />,
      ),
    );

    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Access hub is unavailable");
  });
});