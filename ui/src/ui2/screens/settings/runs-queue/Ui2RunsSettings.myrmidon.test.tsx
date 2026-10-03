// ui/src/ui2/screens/settings/runs-queue/Ui2RunsSettings.myrmidon.test.tsx
//
// myrmidon(UI2): screen guard for Settings → Runs & queue. Parity: the four
// admission ceilings render from the mocked runtime-limits API with their
// source labels, and the legacy PATCH action applies only the changed keys
// through the same runtimeLimitsApi the vendor panel uses.

// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Ui2RunsSettings } from "./Ui2RunsSettings";
import { Ui2I18nProvider } from "../../../i18n/Ui2I18n";

const mockRuntimeLimitsApi = vi.hoisted(() => ({
  get: vi.fn(),
  update: vi.fn(),
}));

vi.mock("@/components/myrmidon/runtimeLimitsApi", () => ({
  runtimeLimitsApi: mockRuntimeLimitsApi,
  runtimeLimitsQueryKey: ["myrmidon", "runtime-limits"],
}));

async function flushReact() {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  flushSync(() => {});
}

function setNativeValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
}

describe("myrmidon(UI2) Ui2RunsSettings screen parity", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let queryClient: QueryClient;

  async function renderScreen() {
    root = createRoot(container);
    flushSync(() => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <Ui2I18nProvider initialLocale="en">
            <Ui2RunsSettings />
          </Ui2I18nProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mockRuntimeLimitsApi.get.mockResolvedValue({
      limits: {
        maxConcurrentRuns: 24,
        maxStartsPerMinute: 12,
        minFreeMemoryMb: null,
        runMemoryEstimateMb: 1536,
      },
      sources: {
        maxConcurrentRuns: "settings",
        maxStartsPerMinute: "settings",
        minFreeMemoryMb: "env",
        runMemoryEstimateMb: "default",
      },
    });
    mockRuntimeLimitsApi.update.mockImplementation(async (_patch) => ({
      limits: {
        maxConcurrentRuns: 16,
        maxStartsPerMinute: 12,
        minFreeMemoryMb: null,
        runMemoryEstimateMb: 1536,
      },
      sources: {
        maxConcurrentRuns: "settings",
        maxStartsPerMinute: "settings",
        minFreeMemoryMb: "env",
        runMemoryEstimateMb: "default",
      },
    }));
  });

  afterEach(() => {
    flushSync(() => {
      root?.unmount();
    });
    root = null;
    container.remove();
    vi.clearAllMocks();
  });

  it("renders the four ceilings with their sources from the mocked API", async () => {
    await renderScreen();

    expect(mockRuntimeLimitsApi.get).toHaveBeenCalled();
    const inputs = [...container.querySelectorAll("input[id^='ui2-run-limit-']")];
    expect(inputs.length).toBe(4);
    const concurrent = container.querySelector<HTMLInputElement>("#ui2-run-limit-maxConcurrentRuns");
    expect(concurrent?.value).toBe("24");
    // minFreeMemoryMb is null (off): its input renders empty and disabled.
    const memory = container.querySelector<HTMLInputElement>("#ui2-run-limit-minFreeMemoryMb");
    expect(memory?.value).toBe("");
    expect(memory?.disabled).toBe(true);
    // Source labels render per key.
    const body = container.textContent ?? "";
    expect(body).toContain("Saved here");
    expect(body).toContain("From the server environment");
  });

  it("applies only the changed limit through the same PATCH api", async () => {
    await renderScreen();

    const concurrent = container.querySelector<HTMLInputElement>("#ui2-run-limit-maxConcurrentRuns");
    expect(concurrent).not.toBeNull();
    setNativeValue(concurrent!, "16");
    await flushReact();

    const save = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Apply",
    );
    expect(save).toBeDefined();
    expect((save as HTMLButtonElement | undefined)?.disabled).toBe(false);

    save?.click();
    await flushReact();

    expect(mockRuntimeLimitsApi.update).toHaveBeenCalledTimes(1);
    expect(mockRuntimeLimitsApi.update).toHaveBeenCalledWith({ maxConcurrentRuns: 16 });
  });
});
