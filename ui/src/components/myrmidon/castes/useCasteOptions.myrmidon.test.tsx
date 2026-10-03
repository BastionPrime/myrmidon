// @vitest-environment jsdom
// myrmidon(1.6.1 CUSTOM-CASTES C): the fallback contract for the shared
// caste-options hook — the pickers (agent card role select, autonomy matrix,
// onboarding) must never lose their options when the directory is empty,
// failing, or no company is selected.
import { act } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCasteOptionsForCompany, casteLabelFor } from "./useCasteOptions";
import { castesApi } from "./castesApi";
import { AGENT_ROLES, AGENT_ROLE_LABELS } from "@paperclipai/shared";

const apiMock = vi.hoisted(() => ({
  view: vi.fn(),
  add: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
}));

vi.mock("./castesApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./castesApi")>()),
  castesApi: apiMock,
}));

let container: HTMLDivElement;
let root: Root | null = null;
let queryClient: QueryClient;
let latest: { options: Array<{ key: string; label: string }>; fromDirectory: boolean } | null = null;

function Probe() {
  const result = useCasteOptionsForCompany("company-1");
  latest = result;
  return null;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  latest = null;
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container.remove();
});

async function renderProbe(): Promise<void> {
  root = createRoot(container);
  flushSync(() => {
    root!.render(
      <QueryClientProvider client={queryClient}>
        <Probe />
      </QueryClientProvider>,
    );
  });
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  flushSync(() => {});
}

describe("myrmidon(1.6.1 CUSTOM-CASTES C) useCasteOptions fallback", () => {
  it("returns the directory entries (RU name first) plus unseeded built-ins", async () => {
    apiMock.view.mockReset().mockResolvedValue({
      castes: [
        {
          key: "data-steward",
          nameEn: "Data steward",
          nameRu: "Хранитель данных",
          description: "",
          color: "var(--hex-8b5cf6)",
          icon: "database",
          defaultModel: null,
          swarmEligible: true,
          maxActiveTasks: null,
          builtIn: false,
          createdAt: "2026-10-03T10:00:00.000Z",
          updatedAt: "2026-10-03T10:00:00.000Z",
        },
      ],
    });
    await renderProbe();
    expect(latest?.fromDirectory).toBe(true);
    const keys = latest?.options.map((option) => option.key);
    expect(keys?.[0]).toBe("data-steward");
    expect(keys).toContain("engineer");
    expect(keys?.length).toBe(AGENT_ROLES.length + 1);
    expect(latest?.options[0]?.label).toBe("Хранитель данных");
  });

  it("falls back to the built-in twelve when the directory request fails", async () => {
    apiMock.view.mockReset().mockRejectedValue(new Error("network down"));
    await renderProbe();
    expect(latest?.fromDirectory).toBe(false);
    expect(latest?.options).toEqual(
      AGENT_ROLES.map((role) => ({ key: role, label: AGENT_ROLE_LABELS[role] })),
    );
  });

  it("falls back to the built-in twelve when the directory is empty", async () => {
    apiMock.view.mockReset().mockResolvedValue({ castes: [] });
    await renderProbe();
    expect(latest?.fromDirectory).toBe(false);
    expect(latest?.options).toEqual(
      AGENT_ROLES.map((role) => ({ key: role, label: AGENT_ROLE_LABELS[role] })),
    );
  });
});

describe("casteLabelFor", () => {
  it("prefers the directory label and falls back to the raw role", () => {
    const options = [
      { key: "data-steward", label: "Хранитель данных" },
      { key: "engineer", label: "Engineer" },
    ];
    expect(casteLabelFor("data-steward", options)).toBe("Хранитель данных");
    expect(casteLabelFor("unknown-role", options)).toBe("unknown-role");
  });
});
