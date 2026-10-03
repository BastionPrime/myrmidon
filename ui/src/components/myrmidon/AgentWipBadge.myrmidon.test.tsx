// @vitest-environment jsdom
// myrmidon(1.6.1 WIP-LIMIT B): the WIP badge on an agent row — view tier, no
// network. Checked: wip/limit text; a null limit renders bare wip; an
// over-limit entry gets the destructive look and the marker; a missing entry
// renders nothing at all.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentWipBadge } from "./AgentWipBadge";
import type { WipLimitStatusEntry } from "./wip-limit/wipLimitApi";

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
  act(() => root.unmount());
  container.remove();
});

const ENTRY: WipLimitStatusEntry = {
  agentId: "agent-1",
  inProgress: 2,
  inReview: 1,
  wip: 3,
  limit: 4,
  overLimit: false,
};

function badge(): HTMLElement | null {
  return container.querySelector<HTMLElement>("[data-testid^=agent-wip-badge-]");
}

describe("myrmidon(1.6.1 WIP-LIMIT B) AgentWipBadge", () => {
  it("renders wip/limit", () => {
    act(() => root.render(<AgentWipBadge status={ENTRY} />));
    expect(badge()?.textContent).toBe("3/4");
    expect(badge()?.dataset.overLimit).toBeUndefined();
  });

  it("renders bare wip when the limit is null (limit off)", () => {
    act(() => root.render(<AgentWipBadge status={{ ...ENTRY, limit: null }} />));
    expect(badge()?.textContent).toBe("3");
  });

  it("marks an over-limit agent", () => {
    act(() => root.render(<AgentWipBadge status={{ ...ENTRY, wip: 5, overLimit: true }} />));
    const el = badge();
    expect(el?.textContent).toBe("5/4");
    expect(el?.dataset.overLimit).toBe("true");
    expect(el?.className).toContain("text-destructive");
  });

  it("renders nothing without a status entry", () => {
    act(() => root.render(<AgentWipBadge status={undefined} />));
    expect(badge()).toBeNull();
  });
});