// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SshGenerateDialogBody } from "./SshGenerateDialog";
import type { AccessHost, SshKeyMaterial } from "./accessHubApi";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const PUBLIC_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIexamplepublichalf deploy@edge";
const FINGERPRINT = "SHA256:0123456789abcdefghijklmnopqrstuvwxyzABCD";

const HOSTS: AccessHost[] = [
  { hostId: "host-a", name: "edge-1" },
  { hostId: "host-b", name: "edge-2" },
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

function button(label: string) {
  return Array.from(container.querySelectorAll("button")).find(
    (element) => element.textContent?.replace(/\s+/g, " ").trim() === label,
  )!;
}

function renderBody(overrides: {
  material?: SshKeyMaterial | null;
  onGenerate?: (input: { name?: string; hostRefs?: string[] }) => Promise<unknown> | unknown;
  onCopyPublicKey?: (publicKey: string) => void;
  onClose?: () => void;
}) {
  flushSync(() =>
    root.render(
      <SshGenerateDialogBody
        hosts={HOSTS}
        material={overrides.material ?? null}
        onGenerate={overrides.onGenerate ?? (() => undefined)}
        onCopyPublicKey={overrides.onCopyPublicKey ?? (() => undefined)}
        onClose={overrides.onClose ?? (() => undefined)}
      />,
    ),
  );
}

describe("SshGenerateDialogBody", () => {
  it("generates a key for the named access and the picked hosts", async () => {
    const onGenerate = vi.fn().mockResolvedValue(undefined);
    renderBody({ onGenerate });

    setInputValue(container.querySelector<HTMLInputElement>('[aria-label="Key name"]')!, "edge deploy key");
    const edgeTwo = container.querySelector<HTMLInputElement>('[aria-label="Deploy to edge-2"]')!;
    flushSync(() => edgeTwo.click());

    await flush(async () => {
      container
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(onGenerate).toHaveBeenCalledWith({ name: "edge deploy key", hostRefs: ["host-b"] });
  });

  it("asks for a name before generating", async () => {
    const onGenerate = vi.fn();
    renderBody({ onGenerate });

    await flush(async () => {
      container
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(onGenerate).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Give the key a name");
  });

  it("shows the public half and its fingerprint once, with a copy action", () => {
    const onCopyPublicKey = vi.fn();
    renderBody({
      material: { secretId: "secret-a", publicKey: PUBLIC_KEY, fingerprint: FINGERPRINT },
      onCopyPublicKey,
    });

    expect(container.querySelector('[data-testid="access-hub-ssh-form"]')).toBeNull();
    const reveal = container.querySelector('[data-testid="access-hub-ssh-material"]')!;
    expect(reveal.textContent).toContain(PUBLIC_KEY);
    expect(reveal.textContent).toContain(FINGERPRINT);
    expect(reveal.textContent).toContain("shown once");

    flushSync(() => button("Copy public key").click());
    expect(onCopyPublicKey).toHaveBeenCalledWith(PUBLIC_KEY);
  });

  it("closes from the reveal view", () => {
    const onClose = vi.fn();
    renderBody({ material: { secretId: "secret-a", publicKey: PUBLIC_KEY, fingerprint: FINGERPRINT }, onClose });

    flushSync(() => button("Done").click());
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});