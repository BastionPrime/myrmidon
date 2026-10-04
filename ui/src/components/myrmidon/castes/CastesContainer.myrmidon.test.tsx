// @vitest-environment jsdom
// myrmidon(1.6.1 CUSTOM-CASTES C): container-tier tests — the wire tier
// against a mocked API client. Checked: the GET directory renders the seeded
// twelve plus a created caste; create POSTs the caste; edit PATCHes the
// mutable fields; remove DELETEs after confirmation; a 409 from the remove
// (live agents hold the role) surfaces as a readable in-use message.
import { act } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CastesScreen } from "./CastesContainer";
import { castesApi } from "./castesApi";
import { ApiError } from "@/api/client";

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

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

const COMPANY_ID = "company-1";

/** The twelve built-in seed rows (the shared contract's seed list). */
function seedCastes() {
  const roles: Array<[string, string]> = [
    ["ceo", "CEO"],
    ["cto", "CTO"],
    ["cmo", "CMO"],
    ["cfo", "CFO"],
    ["security", "Security"],
    ["engineer", "Engineer"],
    ["designer", "Designer"],
    ["pm", "PM"],
    ["qa", "QA"],
    ["devops", "DevOps"],
    ["researcher", "Researcher"],
    ["general", "General"],
  ];
  return roles.map(([key, name]) => ({
    key,
    nameEn: name,
    nameRu: name,
    description: "",
    color: "var(--hex-3b82f6)",
    icon: "bot",
    defaultModel: null,
    swarmEligible: true,
    maxActiveTasks: null,
    builtIn: true,
    createdAt: "2026-10-01T10:00:00.000Z",
    updatedAt: "2026-10-01T10:00:00.000Z",
  }));
}

function customCaste() {
  return {
    key: "data-steward",
    nameEn: "Data steward",
    nameRu: "Данные",
    description: "Owns the data catalog",
    color: "var(--hex-8b5cf6)",
    icon: "database",
    defaultModel: "qwen-plus",
    swarmEligible: true,
    maxActiveTasks: 4,
    builtIn: false,
    createdAt: "2026-10-03T10:00:00.000Z",
    updatedAt: "2026-10-03T10:00:00.000Z",
  };
}

let container: HTMLDivElement;
let root: Root | null = null;
let queryClient: QueryClient;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  apiMock.view.mockReset().mockResolvedValue({ castes: [...seedCastes(), customCaste()] });
  apiMock.add.mockReset();
  apiMock.update.mockReset();
  apiMock.remove.mockReset().mockResolvedValue({ ok: true });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container.remove();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  flushSync(() => {});
}

async function renderScreen(): Promise<void> {
  root = createRoot(container);
  flushSync(() => {
    root!.render(
      <QueryClientProvider client={queryClient}>
        <CastesScreen />
      </QueryClientProvider>,
    );
  });
  await settle();
}

function inputByTestId(id: string): HTMLInputElement {
  return container.querySelector(`[data-testid="${id}"]`) as HTMLInputElement;
}

async function typeInto(input: HTMLInputElement, text: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(selector: string): Promise<void> {
  await act(async () => {
    container
      .querySelector(selector)
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("myrmidon(1.6.1 CUSTOM-CASTES C) container", () => {
  it("loads the directory over the GET endpoint and renders the seed-12 plus the created caste", async () => {
    await renderScreen();
    expect(apiMock.view).toHaveBeenCalledWith(COMPANY_ID);
    // seed-12: one row per built-in key
    for (const key of ["ceo", "cto", "cmo", "cfo", "security", "engineer", "designer", "pm", "qa", "devops", "researcher", "general"]) {
      expect(container.querySelector(`[data-testid="myrmidon-castes-row-${key}"]`)).not.toBeNull();
    }
    // plus the custom caste
    expect(container.querySelector('[data-testid="myrmidon-castes-row-data-steward"]')).not.toBeNull();
    expect(container.textContent).toContain("Data steward");
  });

  it("create POSTs the caste with the directory contract fields", async () => {
    await renderScreen();
    apiMock.add.mockResolvedValue({ caste: customCaste() });
    await click('[data-testid="myrmidon-castes-add-toggle"]');
    await typeInto(inputByTestId("myrmidon-castes-add-key"), "data-steward");
    await typeInto(inputByTestId("myrmidon-castes-add-name-en"), "Data steward");
    await typeInto(inputByTestId("myrmidon-castes-add-name-ru"), "Данные");
    await click('[data-testid="myrmidon-castes-add-submit"]');
    await settle();

    expect(apiMock.add).toHaveBeenCalledWith(COMPANY_ID, {
      key: "data-steward",
      nameEn: "Data steward",
      nameRu: "Данные",
      description: "",
      color: "var(--hex-6366f1)",
      icon: "bot",
      defaultModel: null,
      swarmEligible: true,
      maxActiveTasks: null,
    });
  });

  it("a duplicate-key 409 from create surfaces as the add form error", async () => {
    await renderScreen();
    apiMock.add.mockRejectedValue(new ApiError("Caste key already exists", 409, { error: "duplicate_key" }));
    await click('[data-testid="myrmidon-castes-add-toggle"]');
    await typeInto(inputByTestId("myrmidon-castes-add-key"), "engineer");
    await typeInto(inputByTestId("myrmidon-castes-add-name-en"), "Engineer");
    await typeInto(inputByTestId("myrmidon-castes-add-name-ru"), "Инженер");
    await click('[data-testid="myrmidon-castes-add-submit"]');
    await settle();

    expect(container.querySelector('[data-testid="myrmidon-castes-add-error"]')?.textContent)
      .toContain("Caste key already exists");
  });

  it("edit PATCHes the mutable fields of a caste", async () => {
    await renderScreen();
    apiMock.update.mockResolvedValue({ caste: { ...customCaste(), nameRu: "Хранитель данных" } });
    await click('[data-testid="myrmidon-castes-edit-open-data-steward"]');
    const nameRuInput = inputByTestId("myrmidon-castes-edit-name-ru-data-steward");
    await typeInto(nameRuInput, "Хранитель данных");
    await click('[data-testid="myrmidon-castes-edit-save-data-steward"]');
    await settle();

    expect(apiMock.update).toHaveBeenCalledWith(
      COMPANY_ID,
      "data-steward",
      expect.objectContaining({ nameRu: "Хранитель данных" }),
    );
  });

  it("remove with confirmation DELETEs the caste by key", async () => {
    await renderScreen();
    await click('[data-testid="myrmidon-castes-remove-open-data-steward"]');
    expect(apiMock.remove).not.toHaveBeenCalled();
    await click('[data-testid="myrmidon-castes-confirm-data-steward"] button');
    await settle();
    // no reassign needed — the DELETE carries no body
    expect(apiMock.remove).toHaveBeenCalledWith(COMPANY_ID, "data-steward", null);
  });

  it("myrmidon(1.6.1 CUSTOM-CASTES C annex) a 409 from the remove demands a reassign target and the DELETE carries it", async () => {
    // the directory holds more than the in-use caste, so a target exists
    await renderScreen();
    // first attempt without a target: 409 in-use
    apiMock.remove.mockRejectedValueOnce(new ApiError("Caste in use", 409, { error: "caste_in_use" }));
    await click('[data-testid="myrmidon-castes-remove-open-engineer"]');
    await click('[data-testid="myrmidon-castes-confirm-engineer"] button');
    await settle();
    expect(apiMock.remove).toHaveBeenCalledWith(COMPANY_ID, "engineer", null);

    // the dialog stayed open and gained the reassign select
    const error = container.querySelector('[data-testid="myrmidon-castes-mutation-error"]');
    expect(error).not.toBeNull();
    expect(error?.textContent).toContain("in use");
    const select = container.querySelector<HTMLSelectElement>(
      '[data-testid="myrmidon-castes-reassign-select-engineer"]',
    );
    expect(select).not.toBeNull();
    // confirm blocked until a target is picked
    const confirm = container.querySelector<HTMLButtonElement>(
      '[data-testid="myrmidon-castes-confirm-engineer"] button',
    );
    expect(confirm?.disabled).toBe(true);

    // pick data-steward as the target; the DELETE goes out with the body
    apiMock.remove.mockResolvedValueOnce({ ok: true });
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
      setter?.call(select!, "data-steward");
      select!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await click('[data-testid="myrmidon-castes-confirm-engineer"] button');
    await settle();
    expect(apiMock.remove).toHaveBeenLastCalledWith(COMPANY_ID, "engineer", "data-steward");
    // 204 path: the error clears after the successful reassign-delete
    expect(container.querySelector('[data-testid="myrmidon-castes-mutation-error"]')).toBeNull();
  });

  it("a 409 from the remove renders the readable in-use message", async () => {
    await renderScreen();
    apiMock.remove.mockRejectedValue(new ApiError("Caste in use", 409, { error: "caste_in_use" }));
    await click('[data-testid="myrmidon-castes-remove-open-engineer"]');
    await click('[data-testid="myrmidon-castes-confirm-engineer"] button');
    await settle();
    const error = container.querySelector('[data-testid="myrmidon-castes-mutation-error"]');
    expect(error).not.toBeNull();
    // The message is the readable in-use hint, not the raw API text
    // ("Caste in use") — the i18n key resolves through the real translator.
    expect(error?.textContent).toContain("in use");
    expect(error?.textContent).not.toBe("Caste in use");
  });
});
