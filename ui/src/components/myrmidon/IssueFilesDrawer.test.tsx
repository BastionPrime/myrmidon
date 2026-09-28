// @vitest-environment jsdom

import type { IssueAttachment } from "@paperclipai/shared";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IssueFilesDrawer } from "./IssueFilesDrawer";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// Radix's dismissable layer and drag handling touch pointer-capture APIs
// jsdom does not implement (or implements as throwing stubs) — same set
// FolderControls.test.tsx relies on for its Radix-backed components.
if (!globalThis.PointerEvent) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).PointerEvent = MouseEvent;
}
Element.prototype.hasPointerCapture = () => false;
Element.prototype.setPointerCapture = () => undefined;
Element.prototype.releasePointerCapture = () => undefined;
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => undefined;
}
if (!globalThis.ResizeObserver) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// jsdom's own PointerEvent constructor (when a given jsdom version ships
// one) is not a reliable superset of MouseEventInit: some releases accept a
// PointerEventInit dictionary but silently drop MouseEvent-inherited fields
// such as clientX instead of throwing, which zeroes out drag math without
// any error. Building the event on the long-stable MouseEvent constructor
// and stamping the pointer-specific fields on as own properties afterwards
// keeps the coordinates this test asserts on correct no matter which jsdom
// CI happens to run, instead of depending on PointerEvent's own (version
// -dependent) dictionary handling. React reads native event properties by
// name regardless of the constructor used, so this still drives the
// component's onPointerDown/onPointerMove/onPointerUp handlers faithfully.
interface FiredPointerEventInit {
  pointerId: number;
  clientX: number;
  button?: number;
}

function firePointerEvent(target: EventTarget, type: string, init: FiredPointerEventInit): void {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: init.clientX,
    button: init.button ?? 0,
  });
  Object.defineProperty(event, "pointerId", { value: init.pointerId, configurable: true });
  Object.defineProperty(event, "pointerType", { value: "mouse", configurable: true });
  target.dispatchEvent(event);
}

function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> | undefined;
  flushSync(() => {
    result = callback();
  });
  return result;
}

function attachment(overrides: Partial<IssueAttachment>): IssueAttachment {
  const id = overrides.id ?? "att-1";
  return {
    id,
    companyId: "company-a",
    issueId: "issue-a",
    issueCommentId: null,
    assetId: `asset-${id}`,
    provider: "local_disk",
    objectKey: `objects/${id}`,
    contentType: "application/octet-stream",
    byteSize: 1024,
    sha256: "0".repeat(64),
    originalFilename: `${id}.bin`,
    createdByAgentId: null,
    createdByUserId: null,
    createdAt: new Date("2026-09-27T10:00:00Z"),
    updatedAt: new Date("2026-09-27T10:00:00Z"),
    contentPath: `/api/attachments/${id}/content`,
    ...overrides,
  };
}

const WIDTH_STORAGE_KEY = "myrmidon.issueFilesDrawer.width";

describe("IssueFilesDrawer", () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    window.localStorage.removeItem(WIDTH_STORAGE_KEY);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;
  });

  afterEach(() => {
    if (root) act(() => root?.unmount());
    container.remove();
    document.body.innerHTML = "";
    window.localStorage.removeItem(WIDTH_STORAGE_KEY);
  });

  function render(attachments: IssueAttachment[], isMobile = false) {
    root = createRoot(container);
    act(() => {
      root?.render(
        <IssueFilesDrawer attachments={attachments} workProducts={[]} isMobile={isMobile} />,
      );
    });
  }

  function trigger(): HTMLButtonElement {
    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="issue-files-drawer-trigger"]',
    );
    expect(button).toBeTruthy();
    return button!;
  }

  it("shows the file count and disables the trigger when there is nothing to show", () => {
    render([]);
    const button = trigger();
    expect(button.textContent).toContain("Files (0)");
    expect(button.disabled).toBe(true);
  });

  it("opens on trigger click and lists the task's files", () => {
    render([attachment({ id: "att-open", originalFilename: "mockup.zip" })]);
    expect(trigger().textContent).toContain("Files (1)");

    act(() => {
      trigger().dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    const drawer = document.querySelector('[data-testid="issue-files-drawer"]');
    expect(drawer?.getAttribute("data-state")).toBe("open");
    expect(drawer?.textContent).toContain("mockup.zip");
  });

  it("does not render a resize grip on the mobile bottom sheet", () => {
    render([attachment({ id: "att-mobile" })], true);
    act(() => {
      trigger().dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(document.querySelector('[data-testid="issue-files-drawer"]')?.getAttribute("data-state")).toBe(
      "open",
    );
    expect(document.querySelector('[data-testid="issue-files-drawer-grip"]')).toBeNull();
  });

  it("resizes the desktop panel by dragging the left grip and remembers the width", () => {
    render([attachment({ id: "att-resize" })]);
    act(() => {
      trigger().dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    const drawer = document.querySelector<HTMLElement>('[data-testid="issue-files-drawer"]');
    const grip = document.querySelector<HTMLElement>('[data-testid="issue-files-drawer-grip"]');
    expect(drawer).toBeTruthy();
    expect(grip).toBeTruthy();
    expect(drawer?.style.width).toBe("420px");

    // The grip sits on the panel's left border: dragging left widens it.
    act(() => {
      if (grip) firePointerEvent(grip, "pointerdown", { pointerId: 1, clientX: 500, button: 0 });
    });
    act(() => {
      if (grip) firePointerEvent(grip, "pointermove", { pointerId: 1, clientX: 400 });
    });
    expect(drawer?.style.width).toBe("520px");
    // Not persisted until the drag ends.
    expect(window.localStorage.getItem(WIDTH_STORAGE_KEY)).toBeNull();

    act(() => {
      if (grip) firePointerEvent(grip, "pointerup", { pointerId: 1, clientX: 400 });
    });
    expect(window.localStorage.getItem(WIDTH_STORAGE_KEY)).toBe("520");
  });

  it("clamps a stored width to the 320-900 range on the next mount", () => {
    window.localStorage.setItem(WIDTH_STORAGE_KEY, "50000");
    render([attachment({ id: "att-clamped" })]);
    act(() => {
      trigger().dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    const drawer = document.querySelector<HTMLElement>('[data-testid="issue-files-drawer"]');
    expect(drawer?.style.width).toBe("900px");
  });

  it("follows a file's comment link and closes the drawer on mobile only", () => {
    render([attachment({ id: "att-comment", issueCommentId: "c9" })], true);
    act(() => {
      trigger().dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    const commentLink = document.querySelector<HTMLAnchorElement>('a[href="#comment-c9"]');
    expect(commentLink).toBeTruthy();

    act(() => {
      commentLink?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    // No stylesheet is loaded in this test environment, so Radix's Presence
    // sees no exit animation to wait for and unmounts the panel right away.
    expect(document.querySelector('[data-testid="issue-files-drawer"]')).toBeNull();
  });

  it("leaves the desktop panel open when a comment link is clicked", () => {
    render([attachment({ id: "att-comment-desktop", issueCommentId: "c9" })], false);
    act(() => {
      trigger().dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    const commentLink = document.querySelector<HTMLAnchorElement>('a[href="#comment-c9"]');
    act(() => {
      commentLink?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(document.querySelector('[data-testid="issue-files-drawer"]')?.getAttribute("data-state")).toBe(
      "open",
    );
  });
});
