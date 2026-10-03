// @vitest-environment jsdom
// myrmidon(1.6.1 CUSTOM-CASTES C): view-tier tests for the "Agent castes"
// screen — no network, the view is driven against a fake caste list.
//
// Checked: the table renders every directory column; the add form gates on
// the key constraint and names; remove requires confirmation; the color
// swatches offer only token-layer values; the built-in badge shows; the
// task-limit column distinguishes null (global) from a number.
import { act } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CastesScreenView, CASTE_COLOR_VARS } from "./CastesScreen";
import type { AddCasteInput, CasteView, UpdateCasteInput } from "./castesApi";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const mockT = vi.hoisted(() => {
  const t = (key: string) => key;
  return { t };
});

vi.mock("@/i18n", () => ({ useTranslation: () => mockT }));

function caste(overrides: Partial<CasteView> = {}): CasteView {
  return {
    key: "engineer",
    nameEn: "Engineer",
    nameRu: "Инженер",
    description: "Builds things",
    color: "var(--hex-3b82f6)",
    icon: "code",
    defaultModel: "qwen-plus",
    swarmEligible: true,
    maxActiveTasks: null,
    builtIn: true,
    createdAt: "2026-10-01T10:00:00.000Z",
    updatedAt: "2026-10-01T10:00:00.000Z",
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root | null = null;
let handlers: {
  onAdd: (input: AddCasteInput) => void;
  onUpdate: (key: string, input: UpdateCasteInput) => void;
  onRemove: (key: string, reassignTo: string | null) => void;
};

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  handlers = { onAdd: vi.fn(), onUpdate: vi.fn(), onRemove: vi.fn() };
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container.remove();
});

function render(castes: CasteView[], props: Partial<Parameters<typeof CastesScreenView>[0]> = {}) {
  root = createRoot(container);
  flushSync(() => {
    root!.render(
      <CastesScreenView
        castes={castes}
        onAdd={handlers.onAdd}
        adding={false}
        addError={null}
        onUpdate={handlers.onUpdate}
        updating={false}
        onRemove={handlers.onRemove}
        removing={false}
        error={null}
        {...props}
      />,
    );
  });
  return root;
}

async function flushReact() {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  flushSync(() => {});
}

async function click(selector: string): Promise<void> {
  await act(async () => {
    container
      .querySelector(selector)
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function typeInto(input: HTMLInputElement, text: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("myrmidon(1.6.1 CUSTOM-CASTES C) view tier", () => {
  it("renders the table columns for a seeded and a custom caste", async () => {
    render([caste(), caste({ key: "data-steward", nameEn: "Data steward", nameRu: "Данные", builtIn: false, maxActiveTasks: 4, defaultModel: null })]);
    await flushReact();
    expect(container.querySelector('[data-testid="myrmidon-castes-row-engineer"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="myrmidon-castes-row-data-steward"]')).not.toBeNull();
    // built-in badge on the seeded row only
    expect(container.querySelector('[data-testid="myrmidon-castes-builtin-engineer"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="myrmidon-castes-builtin-data-steward"]')).toBeNull();
    // task limit: null → global, number → the number
    expect(container.querySelector('[data-testid="myrmidon-castes-limit-engineer"]')?.textContent).toBe("castes.list.globalLimit");
    expect(container.querySelector('[data-testid="myrmidon-castes-limit-data-steward"]')?.textContent).toBe("4");
    // default model
    expect(container.querySelector('[data-testid="myrmidon-castes-model-engineer"]')?.textContent).toBe("qwen-plus");
    expect(container.querySelector('[data-testid="myrmidon-castes-model-data-steward"]')?.textContent).toBe("—");
  });

  it("the add form submits the contract fields and the submit gates on key and names", async () => {
    render([caste()]);
    await flushReact();
    await click('[data-testid="myrmidon-castes-add-toggle"]');
    // disabled while the key/names are empty
    const submit = container.querySelector<HTMLButtonElement>('[data-testid="myrmidon-castes-add-submit"]');
    expect(submit?.disabled).toBe(true);

    const keyInput = container.querySelector<HTMLInputElement>('[data-testid="myrmidon-castes-add-key"]');
    const nameEnInput = container.querySelector<HTMLInputElement>('[data-testid="myrmidon-castes-add-name-en"]');
    const nameRuInput = container.querySelector<HTMLInputElement>('[data-testid="myrmidon-castes-add-name-ru"]');
    const modelInput = container.querySelector<HTMLInputElement>('[data-testid="myrmidon-castes-add-model"]');
    await typeInto(keyInput!, "Data Steward!");
    await typeInto(nameEnInput!, "Data steward");
    await typeInto(nameRuInput!, "Данные");
    // the key normalizes (lowercase, spaces/invalid chars stripped)
    expect(submit?.disabled).toBe(false);

    await typeInto(modelInput!, "qwen-plus");
    expect(submit?.disabled).toBe(false);

    await click('[data-testid="myrmidon-castes-add-submit"]');
    expect(handlers.onAdd).toHaveBeenCalledWith({
      key: "datasteward",
      nameEn: "Data steward",
      nameRu: "Данные",
      description: "",
      color: CASTE_COLOR_VARS[0],
      icon: "bot",
      defaultModel: "qwen-plus",
      swarmEligible: true,
      maxActiveTasks: null,
    } satisfies AddCasteInput);
  });

  it("remove requires confirmation and then calls onRemove with the key", async () => {
    render([caste()]);
    await flushReact();
    await click('[data-testid="myrmidon-castes-remove-open-engineer"]');
    expect(handlers.onRemove).not.toHaveBeenCalled();
    // a caste with no known live agents: no reassign select in the dialog
    expect(container.querySelector('[data-testid="myrmidon-castes-reassign-engineer"]')).toBeNull();
    await click('[data-testid="myrmidon-castes-confirm-engineer"] button');
    expect(handlers.onRemove).toHaveBeenCalledWith("engineer", null);
  });

  it("myrmidon(1.6.1 CUSTOM-CASTES C annex) the in-use dialog demands a reassign target and sends it", async () => {
    render([caste(), caste({ key: "data-steward", nameEn: "Data steward", nameRu: "Данные", builtIn: false })], {
      removeNeedsTarget: true,
    });
    await flushReact();
    await click('[data-testid="myrmidon-castes-remove-open-engineer"]');
    // the dialog shows the reassign select (no target chosen yet)
    const select = container.querySelector<HTMLSelectElement>(
      '[data-testid="myrmidon-castes-reassign-select-engineer"]',
    );
    expect(select).not.toBeNull();
    // options: placeholder + every caste except the removed one
    const options = Array.from(select!.options).map((option) => option.value);
    expect(options).toEqual(["", "data-steward"]);
    // without a choice the confirm stays disabled
    const confirm = container.querySelector<HTMLButtonElement>(
      '[data-testid="myrmidon-castes-confirm-engineer"] button',
    );
    expect(confirm?.disabled).toBe(true);

    // pick the target — the confirm unlocks
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
      setter?.call(select!, "data-steward");
      select!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(confirm?.disabled).toBe(false);

    await click('[data-testid="myrmidon-castes-confirm-engineer"] button');
    expect(handlers.onRemove).toHaveBeenCalledWith("engineer", "data-steward");
  });

  it("edit opens the inline form (never the key) and PATCHes via onUpdate", async () => {
    render([caste({ builtIn: false })]);
    await flushReact();
    await click('[data-testid="myrmidon-castes-edit-open-engineer"]');
    // the edit form holds no key input — key is immutable after creation
    expect(container.querySelector('[data-testid="myrmidon-castes-edit-key-engineer"]')).toBeNull();
    const nameRuInput = container.querySelector<HTMLInputElement>('[data-testid="myrmidon-castes-edit-name-ru-engineer"]');
    await typeInto(nameRuInput!, "Инженер данных");
    await click('[data-testid="myrmidon-castes-edit-save-engineer"]');
    expect(handlers.onUpdate).toHaveBeenCalledWith(
      "engineer",
      expect.objectContaining({ nameRu: "Инженер данных" }),
    );
  });

  it("the color swatches offer only token-layer var() values", async () => {
    render([caste()]);
    await flushReact();
    await click('[data-testid="myrmidon-castes-add-toggle"]');
    const swatches = Array.from(
      container.querySelectorAll('[data-testid^="myrmidon-castes-add-color-"]'),
    );
    expect(swatches.length).toBe(CASTE_COLOR_VARS.length);
    for (const swatch of swatches) {
      const color = (swatch as HTMLElement).style.backgroundColor;
      expect(color).toBeTruthy();
    }
    // every offered value is a var() reference, never a literal
    for (const value of CASTE_COLOR_VARS) {
      expect(value.startsWith("var(--")).toBe(true);
    }
  });

  it("renders the mutation error text and the add error separately", async () => {
    render([caste()], { error: "Caste in use", addError: "Key exists" });
    await flushReact();
    expect(container.querySelector('[data-testid="myrmidon-castes-mutation-error"]')?.textContent).toContain("Caste in use");
    await click('[data-testid="myrmidon-castes-add-toggle"]');
    expect(container.querySelector('[data-testid="myrmidon-castes-add-error"]')?.textContent).toContain("Key exists");
  });
});
