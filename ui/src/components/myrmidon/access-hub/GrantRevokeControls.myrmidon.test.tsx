// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GrantRevokeControls } from "./GrantRevokeControls";
import type { AccessBinding } from "./accessHubApi";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const AGENTS = [
  { id: "agent-a", name: "Release bot" },
  { id: "agent-b", name: "Build bot" },
];

const GRANTED: AccessBinding[] = [
  { targetType: "agent", targetId: "agent-a", targetName: "Release bot", configPath: null },
];

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

function setSelectValue(element: HTMLSelectElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(element, value);
  flushSync(() => element.dispatchEvent(new Event("change", { bubbles: true })));
}

function button(label: string) {
  return Array.from(container.querySelectorAll("button")).find(
    (element) => element.textContent?.replace(/\s+/g, " ").trim() === label,
  )!;
}

function renderControls(granted: AccessBinding[], handlers: { onGrant?: (id: string) => void; onRevoke?: (id: string) => void } = {}) {
  flushSync(() =>
    root.render(
      <GrantRevokeControls
        agents={AGENTS}
        granted={granted}
        onGrant={handlers.onGrant ?? (() => undefined)}
        onRevoke={handlers.onRevoke ?? (() => undefined)}
      />,
    ),
  );
}

describe("GrantRevokeControls", () => {
  it("lists the holders and offers the other agents for a grant", () => {
    renderControls(GRANTED);

    const select = container.querySelector<HTMLSelectElement>('[aria-label="Agent to grant"]')!;
    expect(Array.from(select.options).map((option) => option.value)).toEqual(["", "agent-b"]);
    expect(container.textContent).toContain("Release bot");
  });

  it("grants the picked agent and clears the picker", () => {
    const onGrant = vi.fn();
    renderControls([], { onGrant });

    const select = container.querySelector<HTMLSelectElement>('[aria-label="Agent to grant"]')!;
    expect(button("Grant access").disabled).toBe(true);

    setSelectValue(select, "agent-b");
    flushSync(() => button("Grant access").click());

    expect(onGrant).toHaveBeenCalledWith("agent-b");
    expect(select.value).toBe("");
  });

  it("revokes a holder", () => {
    const onRevoke = vi.fn();
    renderControls(GRANTED, { onRevoke });

    flushSync(() => button("Revoke").click());
    expect(onRevoke).toHaveBeenCalledWith("agent-a");
  });

  it("says when nobody holds the access", () => {
    renderControls([]);

    expect(container.textContent).toContain("No agent holds this access yet.");
  });
});