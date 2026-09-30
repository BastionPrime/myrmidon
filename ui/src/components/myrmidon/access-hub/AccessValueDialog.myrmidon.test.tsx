// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccessValueDialogBody, type AccessValueSubmit } from "./AccessValueDialog";
import type { AccessRecord } from "./accessHubApi";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const TYPED_VALUE = "correct-horse-battery-staple";

const RECORD: AccessRecord = {
  secretId: "secret-a",
  name: "Registry token",
  key: "REGISTRY_TOKEN",
  kind: "token",
  status: "active",
  latestVersion: 2,
  createdAt: "2026-09-20T10:00:00.000Z",
  lastRotatedAt: null,
  bindings: [],
  hostRefs: [],
  fingerprint: null,
};

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

function setSelectValue(element: HTMLSelectElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(element, value);
  flushSync(() => element.dispatchEvent(new Event("change", { bubbles: true })));
}

function submit() {
  return flush(() => {
    container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

function valueInput() {
  return container.querySelector<HTMLInputElement>('[data-testid="access-hub-value-input"]')!;
}

function renderBody(overrides: {
  mode: "create" | "set-value";
  record?: AccessRecord | null;
  onSubmit?: (payload: AccessValueSubmit) => Promise<unknown> | unknown;
}) {
  flushSync(() =>
    root.render(
      <AccessValueDialogBody
        mode={overrides.mode}
        record={overrides.record ?? null}
        onSubmit={overrides.onSubmit ?? (() => undefined)}
        onCancel={() => undefined}
      />,
    ),
  );
}

describe("AccessValueDialogBody", () => {
  it("creates an access from name, type and value", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderBody({ mode: "create", onSubmit });

    setInputValue(container.querySelector<HTMLInputElement>('[aria-label="Access name"]')!, "Registry token");
    setInputValue(container.querySelector<HTMLInputElement>('[aria-label="Access key"]')!, "REGISTRY_TOKEN");
    setSelectValue(container.querySelector<HTMLSelectElement>('[aria-label="Access type"]')!, "token");
    setInputValue(valueInput(), TYPED_VALUE);

    await submit();

    expect(onSubmit).toHaveBeenCalledWith({
      name: "Registry token",
      key: "REGISTRY_TOKEN",
      kind: "token",
      value: TYPED_VALUE,
    });
  });

  it("sends the value once and leaves nothing of it on screen", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderBody({ mode: "set-value", record: RECORD, onSubmit });

    setInputValue(valueInput(), TYPED_VALUE);
    // The field never renders the value as text while it is being typed.
    expect(container.textContent).not.toContain(TYPED_VALUE);
    expect(valueInput().type).toBe("password");

    await submit();

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({ secretId: "secret-a", value: TYPED_VALUE });
    expect(valueInput().value).toBe("");
    expect(container.textContent).not.toContain(TYPED_VALUE);
    expect(container.innerHTML).not.toContain(TYPED_VALUE);
  });

  it("keeps the typed value when the write fails, and reports it", async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error("boom"));
    renderBody({ mode: "set-value", record: RECORD, onSubmit, });

    setInputValue(valueInput(), TYPED_VALUE);
    await submit();

    expect(valueInput().value).toBe(TYPED_VALUE);
    expect(container.textContent).not.toContain(TYPED_VALUE);
  });

  it("asks for a name and a value before creating", async () => {
    const onSubmit = vi.fn();
    renderBody({ mode: "create", onSubmit });

    await submit();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Give the access a name");

    setInputValue(container.querySelector<HTMLInputElement>('[aria-label="Access name"]')!, "Registry token");
    await submit();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Enter a value");
  });

  it("names the access being changed", () => {
    renderBody({ mode: "set-value", record: RECORD });

    expect(container.textContent).toContain("Registry token");
    expect(container.textContent).toContain("REGISTRY_TOKEN");
  });
});