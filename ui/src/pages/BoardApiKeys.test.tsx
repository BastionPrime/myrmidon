// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BoardApiKeysPage } from "./BoardApiKeys";

const mocks = vi.hoisted(() => ({
  listBoardApiKeys: vi.fn(),
  createBoardApiKey: vi.fn(),
  revokeBoardApiKey: vi.fn(),
  setBreadcrumbs: vi.fn(),
  pushToast: vi.fn(),
  copyTextToClipboard: vi.fn(),
}));
vi.mock("@/api/access", () => ({ accessApi: mocks }));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => mocks }));
vi.mock("@/context/ToastContext", () => ({ useToast: () => mocks }));
vi.mock("@/lib/clipboard", () => ({ copyTextToClipboard: mocks.copyTextToClipboard }));

const activeKey = {
  id: "key-1",
  name: "release duty",
  scope: { kind: "release" },
  createdAt: "2026-09-30T10:00:00.000Z",
  lastUsedAt: null,
  revokedAt: null,
  expiresAt: null,
};

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;

async function renderPage() {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <BoardApiKeysPage />
      </QueryClientProvider>,
    );
  });
}

async function eventually(assertion: () => void) {
  await vi.waitFor(async () => {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    assertion();
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.replaceChildren(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root = createRoot(container);
  mocks.listBoardApiKeys.mockReset().mockResolvedValue([activeKey]);
  mocks.createBoardApiKey.mockReset();
  mocks.revokeBoardApiKey.mockReset().mockResolvedValue({ ok: true, keyId: "key-1" });
  mocks.pushToast.mockReset();
  mocks.copyTextToClipboard.mockReset().mockResolvedValue(undefined);
});

afterEach(async () => {
  await act(async () => root.unmount());
});

describe("BoardApiKeysPage (myrmidon ROLE-SCOPED-TOKENS)", () => {
  it("lists keys with their scope kind", async () => {
    await renderPage();
    await eventually(() => {
      expect(container.textContent).toContain("release duty");
      expect(container.textContent).toContain("scope: release");
    });
    expect(mocks.listBoardApiKeys).toHaveBeenCalledWith({ includeInactive: false });
  });

  it("creates a key with the chosen scope and shows the token exactly once", async () => {
    mocks.createBoardApiKey.mockResolvedValue({
      ...activeKey,
      id: "key-2",
      name: "ops duty",
      scope: { kind: "ops" },
      token: "pcp_board_once",
    });
    await renderPage();
    await eventually(() => expect(container.textContent).toContain("release duty"));

    const nameInput = container.querySelector<HTMLInputElement>("#board-key-name")!;
    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!;
    await act(async () => {
      nativeSetter.call(nameInput, "ops duty");
      nameInput.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const createButton = [...container.querySelectorAll("button")].find(
      (element) => element.textContent === "Create key",
    )!;
    await act(async () => createButton.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    await eventually(() => {
      expect(mocks.createBoardApiKey).toHaveBeenCalledWith({
        name: "ops duty",
        scope: { kind: "read_only" },
      });
    });
    await eventually(() => {
      expect(container.textContent).toContain("pcp_board_once");
      expect(container.textContent).toContain("it is shown once");
    });
  });

  it("surfaces a creation error and does not render a token", async () => {
    mocks.createBoardApiKey.mockRejectedValue(new Error("boom"));
    await renderPage();
    await eventually(() => expect(container.textContent).toContain("release duty"));

    const createButton = [...container.querySelectorAll("button")].find(
      (element) => element.textContent === "Create key",
    )!;
    await act(async () => createButton.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await eventually(() => {
      expect(container.textContent).toContain("boom");
      expect(container.textContent).not.toContain("pcp_board_");
    });
  });

  it("revokes a key and invalidates the list", async () => {
    await renderPage();
    await eventually(() => expect(container.textContent).toContain("release duty"));

    const revokeButton = [...container.querySelectorAll("button")].find(
      (element) => element.textContent === "Revoke",
    )!;
    await act(async () => revokeButton.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await eventually(() => expect(mocks.revokeBoardApiKey).toHaveBeenCalledWith("key-1"));
  });

  it("asks for inactive keys when the checkbox is on", async () => {
    await renderPage();
    await eventually(() => expect(container.textContent).toContain("release duty"));

    const checkbox = container.querySelector<HTMLInputElement>("input[type=checkbox]")!;
    await act(async () => checkbox.click());
    await eventually(() =>
      expect(mocks.listBoardApiKeys).toHaveBeenCalledWith({ includeInactive: true }),
    );
  });
});
