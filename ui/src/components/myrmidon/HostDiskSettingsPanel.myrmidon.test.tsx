// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { HostDiskSettingsPanel } from "./HostDiskSettingsPanel";
import * as hostDiskApiModule from "./hostDiskApi";

function renderPanel(): HTMLDivElement {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  document.body.appendChild(container);
  createRoot(container).render(
    <QueryClientProvider client={queryClient}>
      <HostDiskSettingsPanel />
    </QueryClientProvider>,
  );
  return container;
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

const view = {
  threshold: { usageThresholdPercent: 85, sources: { usageThresholdPercent: "default" } },
  status: {
    usage: {
      measuredPath: "/srv/data",
      usedPercent: 91,
      usedGb: 91,
      totalGb: 100,
      freeGb: 9,
      growthBytesPerHour: 1024 * 1024 * 1024,
      measuredAt: "2026-10-03T00:00:00Z",
    },
    consumers: [{ path: "/srv/data/workspaces", sizeGb: 40 }],
    overThreshold: true,
    lastSweepAt: "2026-10-03T00:00:00Z",
    lastSignalAt: "2026-10-03T00:00:00Z",
  },
};

async function waitFor(predicate: () => boolean, timeoutMs = 3000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("waitFor timeout");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
}

describe("HostDiskSettingsPanel", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("shows the threshold, the usage numbers, the growth rate and the consumers", async () => {
    vi.spyOn(hostDiskApiModule.hostDiskApi, "get").mockResolvedValue(view as never);
    const container = renderPanel();
    await waitFor(() => Boolean(container.querySelector('[data-testid="host-disk-status"]')));
    const input = container.querySelector<HTMLInputElement>('[data-testid="host-disk-threshold-input"]');
    expect(input?.value).toBe("85");
    expect(container.querySelector('[data-testid="host-disk-over"]')).not.toBeNull();
    expect(container.textContent).toContain("91% used");
    expect(container.textContent).toContain("91 of 100 GB (9 GB free)");
    expect(container.textContent).toContain("+1.0 GB/hour");
    expect(container.textContent).toContain("/srv/data/workspaces — 40 GB");
  });

  it("saves a threshold through the API without a restart", async () => {
    const update = vi.fn().mockResolvedValue(view);
    vi.spyOn(hostDiskApiModule.hostDiskApi, "get").mockResolvedValue(view as never);
    vi.spyOn(hostDiskApiModule.hostDiskApi, "update").mockImplementation(update as never);
    const container = renderPanel();
    await waitFor(() => Boolean(container.querySelector('[data-testid="host-disk-status"]')));
    const input = container.querySelector<HTMLInputElement>('[data-testid="host-disk-threshold-input"]');
    const button = container.querySelector<HTMLButtonElement>("button");
    await act(async () => {
      setInputValue(input!, "70");
    });
    await act(async () => {
      button!.click();
    });
    await waitFor(() => update.mock.calls.length > 0);
    expect(update).toHaveBeenCalledWith({ usageThresholdPercent: 70 });
  });

  it("rejects an out-of-range threshold locally", async () => {
    const update = vi.fn();
    vi.spyOn(hostDiskApiModule.hostDiskApi, "get").mockResolvedValue(view as never);
    vi.spyOn(hostDiskApiModule.hostDiskApi, "update").mockImplementation(update as never);
    const container = renderPanel();
    await waitFor(() => Boolean(container.querySelector('[data-testid="host-disk-status"]')));
    const input = container.querySelector<HTMLInputElement>('[data-testid="host-disk-threshold-input"]');
    const button = container.querySelector<HTMLButtonElement>("button");
    await act(async () => {
      setInputValue(input!, "100");
    });
    await act(async () => {
      button!.click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(update).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Enter a whole number between 1 and 99");
  });

  it("says there is no measurement yet before the first sweep", async () => {
    vi.spyOn(hostDiskApiModule.hostDiskApi, "get").mockResolvedValue({
      threshold: { usageThresholdPercent: 85, sources: { usageThresholdPercent: "default" } },
      status: {
        usage: {
          measuredPath: null, usedPercent: null, usedGb: null, totalGb: null,
          freeGb: null, growthBytesPerHour: null, measuredAt: null,
        },
        consumers: [], overThreshold: false, lastSweepAt: null, lastSignalAt: null,
      },
    } as never);
    const container = renderPanel();
    await waitFor(() => container.textContent?.includes("No measurement yet") ?? false);
    expect(container.querySelector('[data-testid="host-disk-over"]')).toBeNull();
  });
});
