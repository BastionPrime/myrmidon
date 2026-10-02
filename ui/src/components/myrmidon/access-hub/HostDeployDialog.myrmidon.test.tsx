// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostDeployDialogBody } from "./HostDeployDialog";
import type { AccessHost, AccessRecord } from "./accessHubApi";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const HOSTS: AccessHost[] = [
  { hostId: "host-a", name: "edge-1" },
  { hostId: "host-b", name: "edge-2" },
  { hostId: "host-c", name: "edge-3" },
];

function record(hostRefs: string[]): AccessRecord {
  return {
    secretId: "secret-a",
    name: "Deploy key",
    key: "DEPLOY_KEY",
    kind: "ssh_key",
    status: "active",
    latestVersion: 3,
    createdAt: "2026-09-20T10:00:00.000Z",
    lastRotatedAt: null,
    bindings: [],
    hostRefs,
    fingerprint: "SHA256:abc",
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

function submit() {
  return flush(() => {
    container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

function checkbox(label: string) {
  return container.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
}

function renderBody(
  mode: "deploy" | "withdraw",
  hostRefs: string[],
  onSubmit: (hostRefs: string[]) => Promise<unknown> | unknown,
) {
  flushSync(() =>
    root.render(
      <HostDeployDialogBody
        mode={mode}
        record={record(hostRefs)}
        hosts={HOSTS}
        onSubmit={onSubmit}
        onCancel={() => undefined}
      />,
    ),
  );
}

describe("HostDeployDialogBody", () => {
  it("deploys to the picked hosts, keeping the ones already attached", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderBody("deploy", ["host-a"], onSubmit);

    expect(container.querySelector('[aria-label="Deploy to edge-1"]')).toBeNull();
    flushSync(() => checkbox("Deploy to edge-3").click());
    await submit();

    expect(onSubmit).toHaveBeenCalledWith(["host-a", "host-c"]);
  });

  it("withdraws from the picked hosts", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderBody("withdraw", ["host-a", "host-b"], onSubmit);

    flushSync(() => checkbox("Withdraw from edge-2").click());
    await submit();

    expect(onSubmit).toHaveBeenCalledWith(["host-a"]);
  });

  it("can withdraw from every host", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderBody("withdraw", ["host-a", "host-b"], onSubmit);

    flushSync(() => checkbox("Withdraw from edge-1").click());
    flushSync(() => checkbox("Withdraw from edge-2").click());
    await submit();

    expect(onSubmit).toHaveBeenCalledWith([]);
  });

  it("asks for a selection before writing", async () => {
    const onSubmit = vi.fn();
    renderBody("withdraw", ["host-a", "host-b"], onSubmit);

    await submit();

    expect(onSubmit).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Pick the hosts to withdraw from");
  });

  it("says when there is nothing to deploy to", () => {
    renderBody("deploy", ["host-a", "host-b", "host-c"], vi.fn());

    expect(container.textContent).toContain("Every registry host already has this access");
  });
});