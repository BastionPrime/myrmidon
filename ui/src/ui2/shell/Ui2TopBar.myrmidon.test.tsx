// @vitest-environment jsdom
// myrmidon(HERMES-USAGE-COST): view test for the UI-2.0 top-bar forecast
// chip. With no budget configured (monthBudgetCents = 0) the chip must show
// spend only ("{{spend}} spent") instead of the lying "$0 of $0" — with a
// budget it keeps the "{{spend}} of {{budget}}" form.
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const stripMock = vi.hoisted(() => ({
  current: null as
    | {
        colonyActive: number;
        colonyTotal: number;
        fleetAttention: boolean;
        monthSpendCents: number;
        monthBudgetCents: number;
        attentionCount: number;
      }
    | null,
}));

vi.mock("../useUi2Status", () => ({
  useUi2StatusStrip: () => stripMock.current,
  useUi2AttentionCount: () => 0,
}));

vi.mock("../Ui2CommanderPalette", () => ({
  Ui2CommanderPalette: () => null,
}));

// i18n: run the EN defaultValue path (the chip passes defaultValue), so the
// rendered label is the English template with interpolations applied.
vi.mock("@/i18n", () => ({
  useTranslation: () => ({
    t: (_key: string, opts?: { defaultValue?: string } & Record<string, unknown>) => {
      let out = opts?.defaultValue ?? _key;
      for (const [k, v] of Object.entries(opts ?? {})) {
        if (k === "defaultValue") continue;
        out = out.replaceAll(`{{${k}}}`, String(v));
      }
      return out;
    },
  }),
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("@/lib/utils", () => ({ cn: (...parts: unknown[]) => parts.filter(Boolean).join(" ") }));

import { Ui2TopBar } from "./Ui2TopBar";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/** Repo's act pattern: flush the callback sync, then await its result. */
async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

let container: HTMLDivElement;
let root: Root | null = null;

function renderBar() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
}

beforeEach(() => {
  renderBar();
});

afterEach(async () => {
  await act(() => {
    root?.unmount();
  });
  container.remove();
  root = null;
  stripMock.current = null;
});

function baseStrip(overrides: { monthSpendCents?: number; monthBudgetCents?: number } = {}) {
  return {
    colonyActive: 3,
    colonyTotal: 12,
    fleetAttention: false,
    monthSpendCents: 0,
    monthBudgetCents: 0,
    attentionCount: 0,
    ...overrides,
  };
}

async function renderWith(strip: ReturnType<typeof baseStrip>) {
  stripMock.current = strip;
  await act(() => {
    root!.render(<Ui2TopBar />);
  });
  return container.textContent ?? "";
}

describe("myrmidon(HERMES-USAGE-COST) forecast chip", () => {
  it("shows spend only when no budget is configured (no 'of $0')", async () => {
    const text = await renderWith(baseStrip({ monthSpendCents: 31_454 }));
    expect(text).toContain("$315");
    expect(text).not.toContain("of $0");
    expect(text).not.toMatch(/\$0 of \$0/);
  });

  it("shows '$0 spent' with zero spend and no budget (not '$0 of $0')", async () => {
    const text = await renderWith(baseStrip());
    expect(text).toContain("spent");
    expect(text).not.toMatch(/\$0 of \$0/);
  });

  it("keeps the 'spend of budget' form when a budget is set", async () => {
    const text = await renderWith(baseStrip({ monthSpendCents: 3_100, monthBudgetCents: 10_000 }));
    expect(text).toContain("$31");
    expect(text).toContain("$100");
  });
});