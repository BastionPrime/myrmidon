// @vitest-environment jsdom
// myrmidon(1.6.1 WIP-LIMIT B): view-tier tests for the "WIP limit" settings
// screen — no network; the view is driven against a fake settings row and a
// fake status list. The contract (part A) is frozen, so the fixtures mirror
// it: { defaultLimit, perAgent } and [{ agentId, inProgress, inReview, wip,
// limit, overLimit }].
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WipLimitScreenView } from "./WipLimitScreen";
import type { WipLimitSettings, WipLimitStatusEntry } from "./wipLimitApi";
import { parseWipLimitValue, resolveAgentLimit, setPerAgentLimit, wipBadgeText } from "./wipLimitConfig";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const mockT = vi.hoisted(() => {
  const t = (key: string) => key;
  return { t };
});

vi.mock("@/i18n", () => ({ useTranslation: () => mockT }));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

const SETTINGS: WipLimitSettings = {
  defaultLimit: 3,
  perAgent: { "agent-a": 5 },
};

const STATUS: WipLimitStatusEntry[] = [
  { agentId: "agent-a", inProgress: 2, inReview: 1, wip: 3, limit: 5, overLimit: false },
  { agentId: "agent-b", inProgress: 2, inReview: 2, wip: 4, limit: 3, overLimit: true },
];

const AGENTS = [
  { agentId: "agent-a", name: "Alpha" },
  { agentId: "agent-b", name: "Beta" },
];

function renderView(overrides: Partial<Parameters<typeof WipLimitScreenView>[0]> = {}) {
  const onSave = vi.fn();
  const props = {
    settings: SETTINGS,
    status: STATUS,
    agents: AGENTS,
    onSave,
    pending: false,
    error: null,
    ...overrides,
  };
  act(() => {
    root.render(<WipLimitScreenView {...props} />);
  });
  return { onSave, props };
}

function defaultInput(): HTMLInputElement {
  return container.querySelector<HTMLInputElement>("#wip-limit-default")!;
}

function setText(input: HTMLInputElement, value: string) {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function saveButton(): HTMLButtonElement {
  // t() is mocked to return keys, so the button text is the key itself; while
  // pending the label switches to wipLimit.saving.
  return [...container.querySelectorAll("button")].find(
    (b) =>
      b.textContent?.includes("wipLimit.save") ||
      b.textContent?.includes("wipLimit.saving") ||
      b.textContent?.includes("Save WIP limit"),
  )! as HTMLButtonElement;
}

function agentLimitInput(agentId: string): HTMLInputElement {
  // The aria-label carries the agent's display name, not its id.
  const name = AGENTS.find((a) => a.agentId === agentId)?.name ?? agentId;
  return [...container.querySelectorAll<HTMLInputElement>("input")]
    .find((el) => el.getAttribute("aria-label")?.includes(name))!;
}

describe("myrmidon(1.6.1 WIP-LIMIT B) settings screen — view tier", () => {
  it("renders the default limit and the per-agent rows with live wip", () => {
    renderView();
    expect(defaultInput().value).toBe("3");
    expect(container.querySelector("[data-testid=wip-limit-status-agent-a]")?.textContent).toContain("2+1 = 3/5");
    expect(container.querySelector("[data-testid=wip-limit-status-agent-b]")?.textContent).toContain("2+2 = 4/3");
    expect(agentLimitInput("agent-a").value).toBe("5");
    expect(agentLimitInput("agent-b").value).toBe("");
  });

  it("marks an over-limit agent with the badge and a destructive status", () => {
    renderView();
    expect(container.querySelector("[data-testid=wip-limit-over-agent-b]")?.textContent).toContain("wipLimit.overLimit");
    expect(container.querySelector("[data-testid=wip-limit-over-agent-a]")).toBeNull();
  });

  it("saves the edited default and a new per-agent override; clearing sends null", () => {
    const { onSave } = renderView();
    setText(defaultInput(), "4");
    setText(agentLimitInput("agent-b"), "2");
    act(() => saveButton().click());
    expect(onSave).toHaveBeenCalledTimes(1);
    const saved = onSave.mock.calls[0][0] as WipLimitSettings;
    expect(saved.defaultLimit).toBe(4);
    expect(saved.perAgent["agent-b"]).toBe(2);
    expect(saved.perAgent["agent-a"]).toBe(5);
  });

  it("clearing a per-agent field removes the override from the saved row", () => {
    const { onSave } = renderView();
    setText(agentLimitInput("agent-a"), "");
    act(() => saveButton().click());
    const saved = onSave.mock.calls[0][0] as WipLimitSettings;
    expect(Object.prototype.hasOwnProperty.call(saved.perAgent, "agent-a")).toBe(false);
  });

  it("rejects a non-number default and disables the save button", () => {
    const { onSave } = renderView();
    setText(defaultInput(), "abc");
    expect(container.querySelector("[data-testid=wip-limit-default-error]")?.textContent).toBeTruthy();
    expect(saveButton().disabled).toBe(true);
    act(() => saveButton().click());
    expect(onSave).not.toHaveBeenCalled();
  });

  it("shows the error surface and the saving label while pending", () => {
    renderView({ error: "boom", pending: true });
    expect(container.querySelector("[data-testid=myrmidon-wip-limit-error]")?.textContent).toContain("boom");
    expect(saveButton().textContent).toContain("wipLimit.saving");
  });

  it("an empty default means null (limit off), not zero", () => {
    const { onSave } = renderView();
    setText(defaultInput(), "");
    act(() => saveButton().click());
    const saved = onSave.mock.calls[0][0] as WipLimitSettings;
    expect(saved.defaultLimit).toBeNull();
  });

  it("no agents — the empty state, no table", () => {
    renderView({ agents: [] });
    expect(container.querySelector("[data-testid=wip-limit-no-agents]")?.textContent).toContain("wipLimit.noAgents");
    expect(container.querySelector("[data-testid=wip-limit-agent-table]")).toBeNull();
  });
});

describe("myrmidon(1.6.1 WIP-LIMIT B) wipLimitConfig helpers", () => {
  it("parseWipLimitValue: empty → null, digits → number, junk → error", () => {
    expect(parseWipLimitValue("")).toEqual({ ok: true, value: null });
    expect(parseWipLimitValue(" 7 ")).toEqual({ ok: true, value: 7 });
    expect(parseWipLimitValue("0").ok).toBe(false);
    expect(parseWipLimitValue("101").ok).toBe(false);
    expect(parseWipLimitValue("x").ok).toBe(false);
  });

  it("resolveAgentLimit: override wins, null falls back to the default, absent key → default", () => {
    const settings = { defaultLimit: 3, perAgent: { a: 5, b: null } };
    expect(resolveAgentLimit(settings, "a")).toBe(5);
    expect(resolveAgentLimit(settings, "b")).toBe(3);
    expect(resolveAgentLimit(settings, "c")).toBe(3);
    expect(resolveAgentLimit({ defaultLimit: null, perAgent: {} }, "a")).toBeNull();
  });

  it("setPerAgentLimit stores and clears overrides", () => {
    const base = { defaultLimit: 3, perAgent: {} as Record<string, number | null> };
    expect(setPerAgentLimit(base, "a", 7).perAgent.a).toBe(7);
    expect(setPerAgentLimit({ ...base, perAgent: { a: 7 } }, "a", null).perAgent.a).toBeUndefined();
  });

  it("wipBadgeText renders wip/limit and bare wip without a limit", () => {
    expect(wipBadgeText({ wip: 4, limit: 3 })).toBe("4/3");
    expect(wipBadgeText({ wip: 4, limit: null })).toBe("4");
  });
});
