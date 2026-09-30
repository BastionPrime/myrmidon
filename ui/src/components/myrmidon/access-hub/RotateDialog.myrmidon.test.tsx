// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RotateDialogBody } from "./RotateDialog";
import type { AccessRecord } from "./accessHubApi";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function record(overrides: Partial<AccessRecord> = {}): AccessRecord {
  return {
    secretId: "secret-a",
    name: "Deploy key",
    key: "DEPLOY_KEY",
    kind: "ssh_key",
    status: "active",
    latestVersion: 3,
    createdAt: "2026-09-20T10:00:00.000Z",
    lastRotatedAt: "2026-09-25T08:30:00.000Z",
    bindings: [
      { targetType: "agent", targetId: "agent-a", targetName: "Release bot", configPath: null },
    ],
    hostRefs: ["host-a"],
    fingerprint: "SHA256:abc",
    ...overrides,
  };
}

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

async function flush(callback: () => void | Promise<void> = () => undefined) {
  await callback();
  for (let i = 0; i < 3; i += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
}

function setInputValue(element: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
  flushSync(() => element.dispatchEvent(new Event("input", { bubbles: true })));
}

function checkbox(label: string) {
  return container.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
}

function button(label: string) {
  return Array.from(container.querySelectorAll("button")).find(
    (element) => element.textContent?.replace(/\s+/g, " ").trim() === label,
  )!;
}

function renderBody(onSubmit: (input: unknown) => Promise<unknown> | unknown) {
  flushSync(() =>
    root.render(<RotateDialogBody record={record()} onSubmit={onSubmit} onCancel={() => undefined} />),
  );
}

describe("RotateDialogBody", () => {
  it("rotates from the external source and restarts containers by default", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderBody(onSubmit);

    expect(checkbox("Restart affected containers").checked).toBe(true);
    expect(container.textContent).toContain("maintenance window");

    await flush(() => {
      container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(onSubmit).toHaveBeenCalledWith({ external: true, restartContainers: true });
  });

  it("rotates to a typed value without restarting when the operator opts out", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderBody(onSubmit);

    flushSync(() => checkbox("Value typed here").click());
    setInputValue(container.querySelector<HTMLInputElement>('[aria-label="New value"]')!, "brand-new-value");
    flushSync(() => checkbox("Restart affected containers").click());

    await flush(() => {
      container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(onSubmit).toHaveBeenCalledWith({ value: "brand-new-value", restartContainers: false });
    // The typed value does not stay on screen after the write.
    expect(container.querySelector<HTMLInputElement>('[data-testid="access-hub-rotate-value-input"]')!.value).toBe("");
    expect(container.textContent).not.toContain("brand-new-value");
  });

  it("requires a value in the typed-value mode", async () => {
    const onSubmit = vi.fn();
    renderBody(onSubmit);

    flushSync(() => checkbox("Value typed here").click());
    await flush(() => {
      container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(onSubmit).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Enter the new value");
  });

  it("cancels without rotating", () => {
    const onSubmit = vi.fn();
    renderBody(onSubmit);

    flushSync(() => button("Cancel").click());
    expect(onSubmit).not.toHaveBeenCalled();
  });
});