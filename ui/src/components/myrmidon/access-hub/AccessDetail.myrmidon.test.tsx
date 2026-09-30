// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccessDetailView } from "./AccessDetail";
import type { AccessHost, AccessRecord } from "./accessHubApi";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const PUBLIC_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIexamplepublichalf deploy@edge";
const FINGERPRINT = "SHA256:0123456789abcdefghijklmnopqrstuvwxyzABCD";

const HOSTS: AccessHost[] = [
  { hostId: "host-a", name: "edge-1" },
  { hostId: "host-b", name: "edge-2" },
];

const AGENTS = [
  { id: "agent-a", name: "Release bot" },
  { id: "agent-b", name: "Build bot" },
];

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
      {
        targetType: "host",
        targetId: "host-a",
        targetName: "edge-1",
        configPath: "/srv/app/.env",
      },
    ],
    hostRefs: ["host-a"],
    fingerprint: FINGERPRINT,
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

interface Handlers {
  onSetValue?: () => void;
  onRotate?: () => void;
  onGenerateSsh?: () => void;
  onDeployHosts?: () => void;
  onWithdrawHosts?: () => void;
  onGrant?: (agentId: string) => void;
  onRevoke?: (agentId: string) => void;
  onCopyPublicKey?: (publicKey: string) => void;
}

function renderDetail(overrides: Partial<AccessRecord> = {}, handlers: Handlers = {}, sshPublicKey: string | null = null) {
  flushSync(() =>
    root.render(
      <AccessDetailView
        record={record(overrides)}
        hosts={HOSTS}
        agents={AGENTS}
        sshPublicKey={sshPublicKey}
        onSetValue={handlers.onSetValue ?? (() => undefined)}
        onRotate={handlers.onRotate ?? (() => undefined)}
        onGenerateSsh={handlers.onGenerateSsh ?? (() => undefined)}
        onDeployHosts={handlers.onDeployHosts ?? (() => undefined)}
        onWithdrawHosts={handlers.onWithdrawHosts ?? (() => undefined)}
        onGrant={handlers.onGrant ?? (() => undefined)}
        onRevoke={handlers.onRevoke ?? (() => undefined)}
        onCopyPublicKey={handlers.onCopyPublicKey ?? (() => undefined)}
      />,
    ),
  );
}

function button(label: string) {
  return Array.from(container.querySelectorAll("button")).find(
    (element) => element.textContent?.replace(/\s+/g, " ").trim() === label,
  )!;
}

describe("AccessDetailView", () => {
  it("shows the details an operator needs, without the value", () => {
    renderDetail();

    expect(container.textContent).toContain("Deploy key");
    expect(container.textContent).toContain("DEPLOY_KEY");
    expect(container.textContent).toContain("v3");
    expect(container.textContent).toContain("2026-09-20 10:00Z");
    expect(container.textContent).toContain("2026-09-25 08:30Z");
    expect(container.textContent).toContain(FINGERPRINT);
    expect(container.textContent).toContain("/srv/app/.env");
    expect(container.textContent).toContain("Hosts: edge-1");
  });

  it("keeps the SSH actions on ssh keys only", () => {
    renderDetail({ kind: "token" });
    expect(container.textContent).not.toContain("Generate new key");

    renderDetail({ kind: "ssh_key" });
    expect(container.textContent).toContain("Generate new key");
  });

  it("wires the card actions", () => {
    const handlers: Handlers = {
      onSetValue: vi.fn(),
      onRotate: vi.fn(),
      onGenerateSsh: vi.fn(),
      onDeployHosts: vi.fn(),
      onWithdrawHosts: vi.fn(),
    };
    renderDetail({}, handlers);

    flushSync(() => button("Change value").click());
    flushSync(() => button("Rotate").click());
    flushSync(() => button("Generate new key").click());
    flushSync(() => button("Deploy to hosts").click());
    flushSync(() => button("Withdraw from hosts").click());

    expect(handlers.onSetValue).toHaveBeenCalledTimes(1);
    expect(handlers.onRotate).toHaveBeenCalledTimes(1);
    expect(handlers.onGenerateSsh).toHaveBeenCalledTimes(1);
    expect(handlers.onDeployHosts).toHaveBeenCalledTimes(1);
    expect(handlers.onWithdrawHosts).toHaveBeenCalledTimes(1);
  });

  it("only offers withdrawal when a host holds the access", () => {
    renderDetail({ hostRefs: [] });
    expect(button("Withdraw from hosts").disabled).toBe(true);
  });

  it("grants and revokes agents from the card", () => {
    const onGrant = vi.fn();
    const onRevoke = vi.fn();
    renderDetail({}, { onGrant, onRevoke });

    const agentSelect = container.querySelector<HTMLSelectElement>('[aria-label="Agent to grant"]')!;
    // Release bot already holds the access, so it is not offered again.
    expect(Array.from(agentSelect.options).map((option) => option.value)).toEqual(["", "agent-b"]);
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(agentSelect, "agent-b");
    flushSync(() => agentSelect.dispatchEvent(new Event("change", { bubbles: true })));
    flushSync(() => button("Grant access").click());

    expect(onGrant).toHaveBeenCalledWith("agent-b");

    flushSync(() => button("Revoke").click());
    expect(onRevoke).toHaveBeenCalledWith("agent-a");
  });

  it("copies the public half from the reveal block", () => {
    const onCopyPublicKey = vi.fn();
    renderDetail({}, { onCopyPublicKey }, PUBLIC_KEY);

    expect(container.textContent).toContain(PUBLIC_KEY);
    flushSync(() => button("Copy public key").click());
    expect(onCopyPublicKey).toHaveBeenCalledWith(PUBLIC_KEY);
  });
});