// @vitest-environment jsdom
//
// Secrecy guard for the access hub: nothing in this subtree may render a
// secret value. The fixtures below carry every value-shaped field the API is
// not allowed to send (value, secretValue, privateKey), and the assertions
// walk the whole rendered subtree — text and attributes — for them.
//
// The guard is expected to go red the moment a component renders one of those
// fields: see "guard is not vacuous" at the bottom, which renders a component
// that does leak and asserts the watcher catches it.

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AccessListView } from "./AccessList";
import { AccessDetailView } from "./AccessDetail";
import { EMPTY_ACCESS_FILTERS, sshRevealForSelection, type AccessHost, type AccessRecord } from "./accessHubApi";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const SECRET_VALUE = "correct-horse-battery-staple";
const PRIVATE_KEY = "-----BEGIN OPENSSH PRIVATE KEY-----private-half-only";
const PUBLIC_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIexamplepublichalf deploy@edge";
const FINGERPRINT = "SHA256:0123456789abcdefghijklmnopqrstuvwxyzABCD";

const HOSTS: AccessHost[] = [{ hostId: "host-a", name: "edge-1" }];

const AGENTS = [
  { id: "agent-a", name: "Release bot" },
  { id: "agent-b", name: "Build bot" },
];

/**
 * A record as hostile input: the shape the UI is written against plus every
 * value-shaped field the server must never put on the wire.
 */
function hostileRecord(overrides: Partial<AccessRecord> = {}): AccessRecord {
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
        configPath: "/home/deploy/.ssh/authorized_keys",
      },
    ],
    hostRefs: ["host-a"],
    fingerprint: FINGERPRINT,
    value: SECRET_VALUE,
    secretValue: SECRET_VALUE,
    privateKey: PRIVATE_KEY,
    publicKey: PRIVATE_KEY,
    ...overrides,
  } as unknown as AccessRecord;
}

const LEAK_MARKERS = [SECRET_VALUE, PRIVATE_KEY];

/** Fails when any marker shows up in the rendered text or in any attribute. */
function expectNoSecretMaterial(container: HTMLElement) {
  for (const marker of LEAK_MARKERS) {
    expect(container.textContent ?? "").not.toContain(marker);
    expect(container.innerHTML).not.toContain(marker);
    for (const element of Array.from(container.querySelectorAll("*"))) {
      for (const attribute of Array.from(element.attributes)) {
        expect(attribute.value).not.toContain(marker);
      }
      expect(element.getAttribute("title") ?? "").not.toContain(marker);
    }
  }
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

describe("access hub secrecy", () => {
  it("renders the access list without any secret value", () => {
    flushSync(() =>
      root.render(
        <AccessListView
          records={[hostileRecord()]}
          hosts={HOSTS}
          agents={AGENTS}
          filters={EMPTY_ACCESS_FILTERS}
          onFiltersChange={() => undefined}
          onSelect={() => undefined}
          onCreate={() => undefined}
        />,
      ),
    );

    expectNoSecretMaterial(container);
    // Positive control: the list does show what an operator needs to scan.
    expect(container.textContent).toContain("Deploy key");
    expect(container.textContent).toContain("SSH key");
    expect(container.textContent).toContain("Release bot");
    expect(container.textContent).toContain("edge-1");
    expect(container.textContent).toContain("v3");
  });

  it("renders the secret card without values, keeping the public fingerprint", () => {
    flushSync(() =>
      root.render(
        <AccessDetailView
          record={hostileRecord()}
          hosts={HOSTS}
          agents={AGENTS}
          sshPublicKey={null}
          onSetValue={() => undefined}
          onRotate={() => undefined}
          onGenerateSsh={() => undefined}
          onDeployHosts={() => undefined}
          onWithdrawHosts={() => undefined}
          onGrant={() => undefined}
          onRevoke={() => undefined}
          onCopyPublicKey={() => undefined}
        />,
      ),
    );

    expectNoSecretMaterial(container);
    expect(container.textContent).toContain(FINGERPRINT);
    // No card is open with a freshly generated key, so the public half is
    // absent too — the fingerprint is all that survives.
    expect(container.textContent).not.toContain(PUBLIC_KEY);
  });

  it("shows the generated public half only while its own card is open", () => {
    const material = { secretId: "secret-a", publicKey: PUBLIC_KEY, fingerprint: FINGERPRINT };
    expect(sshRevealForSelection(material, "secret-a")).toEqual(material);
    expect(sshRevealForSelection(material, "secret-b")).toBeNull();
    expect(sshRevealForSelection(material, null)).toBeNull();

    const renderCard = (sshPublicKey: string | null) =>
      flushSync(() =>
        root.render(
          <AccessDetailView
            record={hostileRecord()}
            hosts={HOSTS}
            agents={AGENTS}
            sshPublicKey={sshPublicKey}
            onSetValue={() => undefined}
            onRotate={() => undefined}
            onGenerateSsh={() => undefined}
            onDeployHosts={() => undefined}
            onWithdrawHosts={() => undefined}
            onGrant={() => undefined}
            onRevoke={() => undefined}
            onCopyPublicKey={() => undefined}
          />,
        ),
      );

    renderCard(PUBLIC_KEY);
    expect(container.textContent).toContain(PUBLIC_KEY);
    expect(container.textContent).toContain("Copy public key");
    expectNoSecretMaterial(container);

    // Reopening the same card: the public half is gone, the fingerprint stays.
    renderCard(null);
    expect(container.textContent).not.toContain(PUBLIC_KEY);
    expect(container.textContent).toContain(FINGERPRINT);
    expectNoSecretMaterial(container);
  });

  it("guard is not vacuous: a leaking component is caught by the watcher", () => {
    function LeakyRow() {
      return <div data-testid="leaky-row">{SECRET_VALUE}</div>;
    }
    flushSync(() => root.render(<LeakyRow />));
    expect(() => expectNoSecretMaterial(container)).toThrow();
  });
});