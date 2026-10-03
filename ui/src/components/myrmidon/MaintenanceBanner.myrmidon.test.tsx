// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MaintenanceBannerView, aggregateMaintenance, normalizeReason } from "./MaintenanceBanner";
import { MaintenanceSettingsPanelView } from "./MaintenanceSettingsPanel";
import type { MaintenanceStatus, MaintenanceWindowView } from "./maintenanceApi";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

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

function window(overrides: Partial<MaintenanceWindowView> = {}): MaintenanceWindowView {
  return {
    id: "window-a",
    scope: { type: "instance" },
    companyId: null,
    state: "on",
    reason: "deploy",
    drainTimeoutSec: 900,
    onTimeout: "wait",
    startedAt: "2026-09-27T10:00:00.000Z",
    onAt: "2026-09-27T10:01:00.000Z",
    drainDeadlineAt: "2026-09-27T10:15:00.000Z",
    drainTimedOut: false,
    exitRequestedAt: null,
    runningRuns: 0,
    queuedRuns: 2,
    queuedWakeups: 3,
    interruptedRuns: 0,
    ...overrides,
  };
}

function status(windows: MaintenanceWindowView[]): MaintenanceStatus {
  return { active: windows.length > 0, instance: windows.find((w) => w.scope.type === "instance") ?? null, windows };
}

function renderBanner(value: MaintenanceStatus | undefined, companyId: string | null = "company-a") {
  flushSync(() => root.render(<MaintenanceBannerView status={value} companyId={companyId} />));
  return container.querySelector('[data-testid="myrmidon-maintenance-banner"]');
}

describe("MaintenanceBanner", () => {
  it("is hidden outside maintenance", () => {
    expect(renderBanner(undefined)).toBeNull();
    expect(renderBanner(status([]))).toBeNull();
  });

  it("shows an instance window on every company", () => {
    const banner = renderBanner(status([window()]));
    expect(banner).not.toBeNull();
    const summary = banner!.querySelector('[data-testid="myrmidon-maintenance-summary"]')!;
    expect(summary.textContent).toContain("windows: 1");
    expect(banner!.querySelector("span")!.textContent).toBe("Maintenance mode");
    expect(banner!.textContent).toContain("deploy");
    expect(banner!.textContent).toContain("queued wakeups: 3");
  });

  it("shows a draining window with its running runs", () => {
    const banner = renderBanner(status([window({ state: "entering", runningRuns: 2 })]))!;
    expect(banner.textContent).toContain("draining, runs still running: 2");
  });

  it("shows narrower windows only in their company", () => {
    const agentWindow = window({ id: "w-agent", scope: { type: "agent", id: "agent-a" }, companyId: "company-a" });
    expect(renderBanner(status([agentWindow]), "company-a")).not.toBeNull();
    expect(renderBanner(status([agentWindow]), "company-b")).toBeNull();
  });

  function agentWindows(count: number, overrides: Partial<MaintenanceWindowView> = {}) {
    return Array.from({ length: count }, (_, i) =>
      window({
        id: `w-${i}`,
        scope: { type: "agent", id: `agent-${i}` },
        companyId: "company-a",
        reason: `bot container template update (00000000-0000-4000-8000-000000000000)`,
        queuedWakeups: 2,
        ...overrides,
      }),
    );
  }

  it("keeps 47 agent windows in one collapsed plaque with a counter", () => {
    const banner = renderBanner(status(agentWindows(47)))!;
    // One plaque, one summary line, one details row for the batch.
    expect(banner.querySelectorAll('[data-testid="myrmidon-maintenance-details"]')).toHaveLength(1);
    expect(banner.querySelectorAll('[data-testid="myrmidon-maintenance-summary"]')).toHaveLength(1);
    expect(banner.querySelectorAll('[data-testid="myrmidon-maintenance-row"]')).toHaveLength(1);
    const summary = banner.querySelector('[data-testid="myrmidon-maintenance-summary"]')!.textContent!;
    expect(summary).toContain("windows: 47");
    const row = banner.querySelector('[data-testid="myrmidon-maintenance-row"]')!;
    expect(row.textContent).toContain("bot container template update");
    expect(row.textContent).toContain("windows: 47");
    expect(row.textContent).toContain("queued wakeups: 94");
    // Agent ids stay inside the expanded row, never in the collapsed summary.
    expect(summary).not.toContain("agent-");
  });

  it("aggregates agent windows of one kind into a single row", () => {
    const banner = renderBanner(status(agentWindows(3)))!;
    const rows = banner.querySelectorAll('[data-testid="myrmidon-maintenance-row"]');
    expect(rows).toHaveLength(1);
    const text = rows[0].textContent!;
    expect(text).toContain("bot container template update");
    expect(text).toContain("windows: 3");
    expect(text).toContain("queued wakeups: 6");
    expect(text).not.toContain("00000000-0000-4000");
    expect(text).toContain("agent-0, agent-1, agent-2");
    expect(rows[0].getAttribute("title")).toBe("agent-0, agent-1, agent-2");
  });

  it("keeps different kinds of agent windows on separate rows", () => {
    const mixed = [...agentWindows(2), ...agentWindows(1, { id: "w-x", reason: "manual repair" })];
    const banner = renderBanner(status(mixed))!;
    expect(banner.querySelectorAll('[data-testid="myrmidon-maintenance-row"]')).toHaveLength(2);
  });

  it("shows instance and agent windows as rows of one plaque", () => {
    const banner = renderBanner(status([window(), ...agentWindows(2)]))!;
    const rows = banner.querySelectorAll('[data-testid="myrmidon-maintenance-row"]');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("the whole instance (on)");
    const summary = banner.querySelector('[data-testid="myrmidon-maintenance-summary"]')!.textContent!;
    expect(summary).toContain("windows: 3");
  });

  it("folds ending agent windows into one ending row, counted in the plaque", () => {
    const banner = renderBanner(status(agentWindows(4, { state: "leaving" })))!;
    const rows = banner.querySelectorAll('[data-testid="myrmidon-maintenance-row"]');
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("(ending)");
    expect(rows[0].textContent).toContain("windows: 4");
    const summary = banner.querySelector('[data-testid="myrmidon-maintenance-summary"]')!.textContent!;
    expect(summary).toContain("windows: 4");
    expect(summary).toContain("ending");
  });

  it("exposes the latest drain deadline of the batch as the ends-by bound", () => {
    const batch = agentWindows(2, { drainDeadlineAt: "2026-09-27T10:20:00.000Z" });
    batch[1] = { ...batch[1], drainDeadlineAt: "2026-09-27T10:30:00.000Z" };
    const aggregate = aggregateMaintenance(batch);
    expect(aggregate.windowCount).toBe(2);
    expect(aggregate.endsBy).toBe("2026-09-27T10:30:00.000Z");
    const banner = renderBanner(status(batch))!;
    expect(banner.textContent).toContain("ends by");
  });

  it("omits the ends-by phrase when no deadline is known", () => {
    const batch = agentWindows(1, { drainDeadlineAt: "" });
    expect(aggregateMaintenance(batch).endsBy).toBeNull();
    const banner = renderBanner(status(batch))!;
    expect(banner.textContent).not.toContain("ends by");
  });

  it("normalizes reasons without agent identifiers", () => {
    expect(normalizeReason("bot container template update (0f8fad5b-d9cb-469f-a165-70867728950e)")).toBe(
      "bot container template update",
    );
    expect(normalizeReason("deploy")).toBe("deploy");
  });
});

describe("MaintenanceSettingsPanel", () => {
  function renderPanel(value: MaintenanceStatus, onEnter = vi.fn(), onExit = vi.fn()) {
    flushSync(() =>
      root.render(
        <MaintenanceSettingsPanelView status={value} onEnter={onEnter} onExit={onExit} pending={false} error={null} />,
      ),
    );
    return { onEnter, onExit };
  }

  function setValue(element: HTMLInputElement | HTMLSelectElement, value: string) {
    const proto = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(element, value);
    flushSync(() => element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true })));
  }

  it("enters instance maintenance with the chosen timeout and action", () => {
    const { onEnter } = renderPanel(status([]));
    expect(container.textContent).toContain("No maintenance window is open.");
    setValue(container.querySelector<HTMLInputElement>("#myrmidon-maintenance-reason")!, "deploy");
    setValue(container.querySelector<HTMLInputElement>("#myrmidon-maintenance-timeout")!, "60");
    setValue(container.querySelector<HTMLSelectElement>("#myrmidon-maintenance-on-timeout")!, "interrupt_and_retry");
    flushSync(() => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(onEnter).toHaveBeenCalledWith({
      scope: { type: "instance" },
      reason: "deploy",
      drainTimeoutSec: 60,
      onTimeout: "interrupt_and_retry",
    });
  });

  it("asks for confirmation before ending a window", () => {
    const { onExit } = renderPanel(status([window()]));
    const endButton = [...container.querySelectorAll("button")].find((b) => b.textContent === "End maintenance")!;
    flushSync(() => endButton.click());
    expect(onExit).not.toHaveBeenCalled();
    const confirm = [...container.querySelectorAll("button")].find((b) => b.textContent === "Confirm end")!;
    flushSync(() => confirm.click());
    expect(onExit).toHaveBeenCalledWith({ type: "instance" });
  });
});
