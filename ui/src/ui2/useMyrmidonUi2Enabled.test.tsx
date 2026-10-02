// @vitest-environment jsdom
// myrmidon(UI-0a): tests for the enableMyrmidonUi2 flag resolution and hook —
// the shell must be strictly opt-in: off while loading, off on read failure,
// off when the key is missing, on only for an explicit true.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveMyrmidonUi2Enabled, useMyrmidonUi2Enabled } from "./useMyrmidonUi2Enabled";

const mockInstanceSettingsApi = vi.hoisted(() => ({ getExperimental: vi.fn() }));

vi.mock("@/api/instanceSettings", () => ({
  instanceSettingsApi: mockInstanceSettingsApi,
}));

function Probe() {
  const state = useMyrmidonUi2Enabled();
  return <output>{`${state.enabled}:${state.loaded}`}</output>;
}

async function flushReact() {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  flushSync(() => {});
}

describe("resolveMyrmidonUi2Enabled", () => {
  it("is off for missing, null, and empty settings", () => {
    expect(resolveMyrmidonUi2Enabled(undefined)).toBe(false);
    expect(resolveMyrmidonUi2Enabled(null)).toBe(false);
    expect(resolveMyrmidonUi2Enabled({} as never)).toBe(false);
  });

  it("is on only for an explicit true", () => {
    expect(resolveMyrmidonUi2Enabled({ enableMyrmidonUi2: true })).toBe(true);
    expect(resolveMyrmidonUi2Enabled({ enableMyrmidonUi2: false })).toBe(false);
  });
});

describe("useMyrmidonUi2Enabled", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    host.remove();
    vi.clearAllMocks();
  });

  it("stays off while the settings request is in flight (no shell flash)", () => {
    mockInstanceSettingsApi.getExperimental.mockImplementation(() => new Promise(() => {}));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    flushSync(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Probe />
        </QueryClientProvider>,
      );
    });

    expect(host.textContent).toBe("false:false");
  });

  it("turns on only for an explicit true from the settings payload", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableMyrmidonUi2: true });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    flushSync(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Probe />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    expect(host.textContent).toBe("true:true");
  });

  it("resolves off when the payload omits the flag (legacy stored rows)", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableStreamlinedUi: true });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    flushSync(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Probe />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    expect(host.textContent).toBe("false:true");
  });

  it("fails closed on a settings read error", async () => {
    mockInstanceSettingsApi.getExperimental.mockRejectedValue(new Error("network down"));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    flushSync(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Probe />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    expect(host.textContent).toBe("false:true");
  });
});
