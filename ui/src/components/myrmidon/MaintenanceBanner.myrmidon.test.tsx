// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MaintenanceBannerView, normalizeReason } from "./MaintenanceBanner";
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
    expect(banner!.textContent).toContain("Maintenance for the whole instance (on)");
    expect(banner!.textContent).toContain("deploy");
    expect(banner!.textContent).toContain("queued (3)");
  });

  it("shows a draining window with its running runs", () => {
    const banner = renderBanner(status([window({ state: "entering", runningRuns: 2 })]));
    expect(banner!.textContent).toContain("draining, runs still running: 2");
  });

  it("shows narrower windows only in their company", () => {
    const agentWindow = window({ id: "w-agent", scope: { type: "agent", id: "agent-a" }, companyId: "company-a" });
    expect(renderBanner(status([agentWindow]), "company-a")!.textContent).toContain("Agent maintenance (on)");
    expect(renderBanner(status([agentWindow]), "company-b")).toBeNull();
  });

  function agentWindows(count: number, overrides: Partial<MaintenanceWindowView> = {}) {
    return Array.from({ length: count }, (_, i) =>
      window({
        id: `w-${i}`,
        scope: { type: "agent", id: `agent-${i}` },
        companyId: "company-a",
        reason: `bot container template update (00000000-0000-4000-8000-00000000000${i})`,
        queuedWakeups: 2,
        ...overrides,
      }),
    );
  }

  it("aggregates agent windows of one kind into a single line", () => {
    const banner = renderBanner(status(agentWindows(3)))!;
    const groups = banner.querySelectorAll('[data-testid="myrmidon-maintenance-agent-group"]');
    expect(groups).toHaveLength(1);
    const text = groups[0].textContent!;
    expect(text).toContain("bot container template update");
    expect(text).toContain("agents: 3");
    expect(text).toContain("queued wakeups: 6");
    expect(text).not.toContain("00000000-0000-4000");
    expect(text).toContain("agent-0, agent-1, agent-2");
    expect(groups[0].querySelector("summary")!.getAttribute("title")).toBe("agent-0, agent-1, agent-2");
  });

  it("keeps different kinds of agent windows on separate lines", () => {
    const mixed = [...agentWindows(2), ...agentWindows(1, { id: "w-x", reason: "manual repair" })];
    const banner = renderBanner(status(mixed))!;
    expect(banner.querySelectorAll('[data-testid="myrmidon-maintenance-agent-group"]')).toHaveLength(2);
  });

  it("shows instance and agent windows separately", () => {
    const banner = renderBanner(status([window(), ...agentWindows(2)]))!;
    expect(banner.textContent).toContain("Maintenance for the whole instance (on)");
    expect(banner.querySelectorAll('[data-testid="myrmidon-maintenance-agent-group"]')).toHaveLength(1);
  });

  it("collapses ending agent windows into one compact line", () => {
    const banner = renderBanner(status(agentWindows(4, { state: "leaving" })))!;
    const ending = banner.querySelectorAll('[data-testid="myrmidon-maintenance-ending"]');
    expect(ending).toHaveLength(1);
    expect(ending[0].textContent).toBe("Agent maintenance ending — agents: 4");
    expect(banner.querySelector('[data-testid="myrmidon-maintenance-agent-group"]')).toBeNull();
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
