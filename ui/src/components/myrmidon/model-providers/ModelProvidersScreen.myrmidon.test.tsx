// @vitest-environment jsdom
// myrmidon(1.6.1 MODEL-PROVIDERS C): view-tier tests for the Model providers
// screen — layout, the write-only key rule, model enable checkboxes, the
// free-first / free-DashScope-first ordering, remove with confirmation,
// rotate with a "new key" field, and the change log.
//
// The write-only key rule is the acceptance criterion: after a save the
// component renders only the API's key-free fields — the raw key value must
// never appear anywhere in the DOM.
import { act } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelProvidersScreenView } from "./ModelProvidersScreen";
import {
  modelProvidersApi,
  sortModels,
  type ModelProviderModelView,
  type ModelProvidersView,
} from "./modelProvidersApi";

// The view tier drives the per-provider models query through the real
// react-query layer, so the API module is partially mocked like the
// container tier (sortModels itself stays the real implementation).
vi.mock("./modelProvidersApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./modelProvidersApi")>()),
  modelProvidersApi: {
    view: vi.fn(),
    add: vi.fn(),
    rotate: vi.fn(),
    remove: vi.fn(),
    models: vi.fn(),
    updateModels: vi.fn(),
  },
}));

const COMPANY_ID = "company-1";
const RAW_KEY = "sk-provider-secret-DO-NOT-RENDER";

function models(overrides: Partial<ModelProviderModelView> = {}): ModelProviderModelView[] {
  return [
    { modelName: "qwen-plus", litellmModelName: "dashscope/qwen-plus", enabled: false, free: true },
    { modelName: "gpt-4o", litellmModelName: "openai/gpt-4o", enabled: false, free: false },
    { modelName: "qwen-turbo", litellmModelName: "dashscope/qwen-turbo", enabled: true, free: true },
    ...([] as ModelProviderModelView[]),
    ...[overrides] as ModelProviderModelView[],
  ].filter((m) => m.modelName !== undefined) as ModelProviderModelView[];
}

function view(): ModelProvidersView {
  return {
    providers: [
      {
        id: "prov-1",
        type: "dashscope",
        name: "DashScope main",
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        hasKey: true,
        free: true,
        createdAt: "2026-10-01T10:00:00.000Z",
        updatedAt: "2026-10-02T12:00:00.000Z",
      },
    ],
    changeLog: [
      {
        id: "cl-1",
        at: "2026-10-02T12:00:00.000Z",
        actor: { type: "board", id: "user-1" },
        action: "provider_added",
        summary: "DashScope main",
      },
    ],
  };
}

function render(props: Partial<Parameters<typeof ModelProvidersScreenView>[0]> = {}) {
  const handlers = {
    onAdd: vi.fn(),
    onRotate: vi.fn(),
    onRemove: vi.fn(),
    onToggleModel: vi.fn(),
    ...props,
  };
  const root = createRoot(container);
  flushSync(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <ModelProvidersScreenView
          view={view()}
          companyId={COMPANY_ID}
          modelsQuery={(providerId: string) => ["myrmidon", "model-providers", COMPANY_ID, "models", providerId]}
          onAdd={handlers.onAdd}
          adding={false}
          addError={null}
          onRotate={handlers.onRotate}
          rotating={false}
          onRemove={handlers.onRemove}
          removing={false}
          onToggleModel={handlers.onToggleModel}
          savingModels={false}
          error={null}
          {...props}
        />
      </QueryClientProvider>,
    );
  });
  return { root, handlers };
}

let container: HTMLDivElement;
let queryClient: QueryClient;
let root: Root | null = null;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.mocked(modelProvidersApi.models).mockResolvedValue({
    providerId: "prov-1",
    models: [
      { modelName: "qwen-turbo", litellmModelName: "dashscope/qwen-turbo", enabled: true, free: true },
      { modelName: "qwen-plus", litellmModelName: "dashscope/qwen-plus", enabled: false, free: true },
      { modelName: "gpt-4o", litellmModelName: "openai/gpt-4o", enabled: false, free: false },
    ],
  });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container.remove();
});

async function flushReact() {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  flushSync(() => {});
}

describe("myrmidon(1.6.1 MODEL-PROVIDERS C) view tier", () => {
  it("renders the provider list with key-free fields only", async () => {
    const { root: r } = render();
    root = r;
    await flushReact();
    expect(container.textContent).toContain("DashScope main");
    // hasKey surfaces as a label, never a value.
    expect(container.querySelector('[data-testid="myrmidon-model-provider-haskey-prov-1"]')?.textContent)
      .toBeTruthy();
    expect(container.textContent).not.toContain("sk-");
    expect(container.innerHTML).not.toContain("credential");
  });

  it("renders models with free/paid flags and the owner's free-DashScope-first order", async () => {
    const { root: r } = render();
    root = r;
    await flushReact();
    const rows = Array.from(
      container.querySelectorAll('[data-testid^="myrmidon-model-row-prov-1-"]'),
    );
    // Owner rule: free first (DashScope free at the top), paid last; stable
    // alphabetical order inside the free group.
    expect(rows.map((row) => row.querySelector(".font-mono")?.textContent)).toEqual([
      "qwen-plus",
      "qwen-turbo",
      "gpt-4o",
    ]);
    expect(
      container.querySelector('[data-testid="myrmidon-model-tier-prov-1-gpt-4o"]')?.textContent,
    ).toBe("Paid");
    expect(
      container.querySelector('[data-testid="myrmidon-model-tier-prov-1-qwen-turbo"]')?.textContent,
    ).toBe("Free");
  });

  it("toggling a model checkbox calls onToggleModel with the flipped row", async () => {
    const { handlers, root: r } = render();
    root = r;
    await flushReact();
    const toggle = container.querySelector<HTMLDivElement>('[data-testid="myrmidon-model-toggle-prov-1-qwen-plus"] input')
      ?? container.querySelector<HTMLInputElement>('[data-testid="myrmidon-model-toggle-prov-1-qwen-plus"]');
    await act(async () => {
      toggle?.click();
    });
    expect(handlers.onToggleModel).toHaveBeenCalledWith("prov-1", [
      expect.objectContaining({ modelName: "qwen-plus", enabled: true }),
      expect.objectContaining({ modelName: "qwen-turbo", enabled: true }),
      expect.objectContaining({ modelName: "gpt-4o", enabled: false }),
    ]);
  });

  it("remove requires confirmation and then calls onRemove", async () => {
    const { handlers, root: r } = render();
    root = r;
    await flushReact();
    await act(async () => {
      container
        .querySelector('[data-testid="myrmidon-model-provider-remove-open-prov-1"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(handlers.onRemove).not.toHaveBeenCalled();
    const confirm = container.querySelector('[data-testid="myrmidon-model-provider-confirm-prov-1"] button');
    await act(async () => {
      confirm?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(handlers.onRemove).toHaveBeenCalledWith("prov-1");
  });

  it("rotate opens a new-key field and submits the trimmed key, then closes", async () => {
    const { handlers, root: r } = render();
    root = r;
    await flushReact();
    await act(async () => {
      container
        .querySelector('[data-testid="myrmidon-model-provider-rotate-open-prov-1"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const keyInput = container.querySelector<HTMLInputElement>(
      '[data-testid="myrmidon-model-provider-rotate-key-prov-1"]',
    );
    expect(keyInput).not.toBeNull();
    // React controlled input: set through the native setter so onChange fires.
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    await act(async () => {
      nativeSetter?.call(keyInput, RAW_KEY);
      keyInput?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const submit = container.querySelector('[data-testid="myrmidon-model-provider-rotate-prov-1"] button');
    await act(async () => {
      submit?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(handlers.onRotate).toHaveBeenCalledWith("prov-1", RAW_KEY);
    // The rotate field closes after submit: the key does not stay in the DOM.
    expect(
      container.querySelector('[data-testid="myrmidon-model-provider-rotate-key-prov-1"]'),
    ).toBeNull();
  });

  it("the add form submits the raw key once and never re-renders it", async () => {
    const { handlers, root: r } = render();
    root = r;
    await flushReact();
    await act(async () => {
      container
        .querySelector('[data-testid="myrmidon-model-providers-add-toggle"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const nameInput = container.querySelector<HTMLInputElement>('[data-testid="myrmidon-model-providers-add-name"]');
    const keyInput = container.querySelector<HTMLInputElement>('[data-testid="myrmidon-model-providers-add-key"]');
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    await act(async () => {
      nativeSetter?.call(nameInput, "OpenAI prod");
      nameInput?.dispatchEvent(new Event("input", { bubbles: true }));
      nativeSetter?.call(keyInput, RAW_KEY);
      keyInput?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      container
        .querySelector('[data-testid="myrmidon-model-providers-add-submit"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(handlers.onAdd).toHaveBeenCalledWith(
      expect.objectContaining({ name: "OpenAI prod", key: RAW_KEY, type: "dashscope" }),
    );
    // Acceptance: the key value never lands in the DOM after the save — the
    // controlled input is cleared with the form.
    expect(container.innerHTML).not.toContain(RAW_KEY);
    const keyInputAfter = container.querySelector<HTMLInputElement>(
      '[data-testid="myrmidon-model-providers-add-key"]',
    );
    expect(keyInputAfter?.value ?? "").toBe("");
  });

  it("renders the change log entries", async () => {
    const { root: r } = render();
    root = r;
    await flushReact();
    expect(container.textContent).toContain("provider_added");
    expect(container.textContent).toContain("DashScope main");
  });
});

describe("sortModels (owner rule: free first, free DashScope before other free)", () => {
  it("orders free DashScope models first, then other free, then paid", () => {
    const sorted = sortModels([
      { modelName: "gpt-4o", litellmModelName: "openai/gpt-4o", enabled: false, free: false },
      { modelName: "llama-free", litellmModelName: "other/llama-free", enabled: false, free: true },
      { modelName: "qwen-max", litellmModelName: "dashscope/qwen-max", enabled: false, free: true },
      { modelName: "qwen-turbo", litellmModelName: "dashscope/qwen-turbo", enabled: false, free: false },
    ]);
    expect(sorted.map((m) => m.modelName)).toEqual(["qwen-max", "llama-free", "gpt-4o", "qwen-turbo"]);
  });
});
