// @vitest-environment jsdom
//
// myrmidon(1.6.1 WIP-LIMIT B): the "WIP Limit" settings screen view. The API
// client (part A contract) is mocked here — see ui/src/api/wipLimit.ts.

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "@paperclipai/shared";
import {
  parseWipLimitDraft,
  toWipLimitDraft,
  WipLimitSettingsView,
  type WipLimitDraft,
} from "./WipLimitSettings";

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

const agent = (id: string, name: string): Agent =>
  ({
    id,
    name,
    title: null,
    role: "engineer",
    status: "active",
    adapterType: "codex_local",
  }) as unknown as Agent;

const agents = [agent("agent-1", "Alpha"), agent("agent-2", "Beta")];

const settings = {
  defaultLimit: 3,
  perAgent: { "agent-2": 5 } as Record<string, number | null>,
};

const statusRows = [
  {
    agentId: "agent-1",
    inProgress: 2,
    inReview: 1,
    wip: 3,
    limit: 3,
    overLimit: false,
  },
  {
    agentId: "agent-2",
    inProgress: 4,
    inReview: 2,
    wip: 6,
    limit: 5,
    overLimit: true,
  },
];

/** Wraps the view with real draft state so edits persist across keystrokes. */
function Harness(
  props: Partial<Parameters<typeof WipLimitSettingsView>[0]>,
) {
  const [draft, setDraft] = useState<WipLimitDraft | null>(null);
  const onSave = props.onSave as (next: { defaultLimit: number | null; perAgent: Record<string, number | null> }) => void;
  return (
    <WipLimitSettingsView
      agents={agents}
      settings={settings}
      statusRows={statusRows}
      draft={draft}
      onDraftChange={setDraft}
      pending={false}
      error={null}
      {...props}
      onSave={onSave}
    />
  );
}

function render(overrides: Partial<Parameters<typeof WipLimitSettingsView>[0]> = {}) {
  const onSave = vi.fn();
  flushSync(() => {
    root.render(<Harness onSave={onSave} {...overrides} />);
  });
  return onSave;
}

function field(testId: string): HTMLInputElement {
  return container.querySelector(`[data-testid="${testId}"]`) as HTMLInputElement;
}

function type(testId: string, text: string) {
  const input = field(testId);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  flushSync(() => {
    setter.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function saveButton(): HTMLButtonElement {
  return container.querySelector('[data-testid="wip-limit-save"]') as HTMLButtonElement;
}

describe("myrmidon(1.6.1 WIP-LIMIT-B) settings screen", () => {
  it("shows the default limit and per-agent values from the contract", () => {
    render();
    expect(field("wip-limit-default").value).toBe("3");
    expect(field("wip-limit-agent-agent-2").value).toBe("5");
    // Agents without an override start empty (= default).
    expect(field("wip-limit-agent-agent-1").value).toBe("");
  });

  it("shows current wip/limit and the over-limit badge", () => {
    render();
    const rows = [...container.querySelectorAll("tbody tr")];
    expect(rows[0]!.textContent).toContain("3/3");
    expect(rows[1]!.textContent).toContain("6/5");
    expect(
      container.querySelector("[data-testid='wip-limit-over-agent-2']"),
    ).not.toBeNull();
    expect(
      container.querySelector("[data-testid='wip-limit-over-agent-1']"),
    ).toBeNull();
  });

  it("saves the parsed settings through the contract", () => {
    const onSave = render();
    type("wip-limit-default", "4");
    type("wip-limit-agent-agent-1", "2");
    flushSync(() => saveButton().dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onSave).toHaveBeenCalledWith({
      defaultLimit: 4,
      perAgent: { "agent-1": 2, "agent-2": 5 },
    });
  });

  it("refuses a non-positive number and does not save", () => {
    const onSave = render();
    type("wip-limit-default", "0");
    expect(container.querySelector("[data-testid='wip-limit-default-error']")).not.toBeNull();
    expect(saveButton().disabled).toBe(true);
    flushSync(() => saveButton().dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onSave).not.toHaveBeenCalled();
  });

  it("an empty default means the limit is off", () => {
    const onSave = render();
    type("wip-limit-default", "");
    flushSync(() => saveButton().dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onSave).toHaveBeenCalledWith({
      defaultLimit: null,
      perAgent: { "agent-2": 5 },
    });
  });

  it("a cleared per-agent field removes the override", () => {
    const onSave = render();
    type("wip-limit-agent-agent-2", "");
    flushSync(() => saveButton().dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onSave).toHaveBeenCalledWith({
      defaultLimit: 3,
      perAgent: {},
    });
  });

  it("an explicit per-agent 'off' disables the limit for that agent", () => {
    const onSave = render();
    type("wip-limit-agent-agent-1", "off");
    flushSync(() => saveButton().dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onSave).toHaveBeenCalledWith({
      defaultLimit: 3,
      perAgent: { "agent-1": null, "agent-2": 5 },
    });
  });

  it("shows a server error", () => {
    render({ error: "Board access required" });
    expect(container.textContent).toContain("Board access required");
  });

  it("shows a hint row when the agent list is empty", () => {
    render({ agents: [] });
    expect(container.textContent).toContain("No agents yet.");
  });
});

describe("myrmidon(1.6.1 WIP-LIMIT-B) draft parsing", () => {
  it("parses defaults, overrides, off and empty", () => {
    expect(
      parseWipLimitDraft({
        defaultLimit: " 4 ",
        perAgent: { a: "2", b: "off", c: "default", d: "" },
      }),
    ).toEqual({
      settings: { defaultLimit: 4, perAgent: { a: 2, b: null } },
      errors: { defaultLimit: null, perAgent: {} },
    });
  });

  it("an empty default is null (limit off)", () => {
    expect(parseWipLimitDraft({ defaultLimit: "", perAgent: {} })).toEqual({
      settings: { defaultLimit: null, perAgent: {} },
      errors: { defaultLimit: null, perAgent: {} },
    });
  });

  it("rejects zero, negatives and decimals", () => {
    const result = parseWipLimitDraft({
      defaultLimit: "-1",
      perAgent: { a: "0", b: "1.5" },
    });
    expect(result.settings).toBeNull();
    expect(result.errors.defaultLimit).toBeTruthy();
    expect(result.errors.perAgent.a).toBeTruthy();
    expect(result.errors.perAgent.b).toBeTruthy();
  });

  it("round-trips settings into a draft", () => {
    expect(toWipLimitDraft(settings)).toEqual({
      defaultLimit: "3",
      perAgent: { "agent-2": "5" },
    });
    expect(toWipLimitDraft({ defaultLimit: null, perAgent: { a: null } })).toEqual({
      defaultLimit: "",
      perAgent: { a: "off" },
    });
  });
});
