// @vitest-environment jsdom

// myrmidon(CLOUD-CONNECTOR): Clouds page view tests.
// The view is presentational: it renders the accounts, the folders, the grants
// and the journal, and reports every owner action through a callback. The API
// client is not involved here, so the owner-facing contract is provable
// without a server.

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CloudAccount,
  CloudGrant,
  CloudJournalEntry,
  CloudRoot,
} from "@paperclipai/shared/myrmidon-cloud-connector";
import { CloudsSettingsPageView, type CloudsSettingsPageViewProps } from "./CloudsSettingsPage";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const COMPANY_ID = "company-a";

function account(overrides: Partial<CloudAccount> = {}): CloudAccount {
  return {
    id: "account-1",
    providerId: "onedrive",
    displayName: "Owner OneDrive",
    companyId: COMPANY_ID,
    tokenRef: "secret-1",
    scopes: [],
    connectedAt: "2026-01-01T00:00:00.000Z",
    connectedBy: "user-owner",
    ...overrides,
  };
}

function root_(overrides: Partial<CloudRoot> = {}): CloudRoot {
  return {
    id: "root-work",
    providerId: "onedrive",
    companyId: COMPANY_ID,
    name: "work",
    kind: "own",
    description: "",
    driveId: null,
    itemId: null,
    folder: "Agents/agent-a",
    personalForAgentId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function grant(overrides: Partial<CloudGrant> = {}): CloudGrant {
  return {
    id: "grant-1",
    rootId: "root-work",
    targetKind: "agent",
    agentId: "agent-a",
    caste: null,
    mode: "rw",
    createdAt: "2026-01-01T00:00:00.000Z",
    createdBy: "user-owner",
    ...overrides,
  };
}

function journalEntry(overrides: Partial<CloudJournalEntry> = {}): CloudJournalEntry {
  return {
    id: "entry-1",
    at: "2026-01-01T00:00:00.000Z",
    actor: "agent-a",
    tool: "cloud_upload",
    rootId: "root-work",
    rootName: "work",
    path: "notes.txt",
    ok: true,
    detail: "uploaded notes.txt (5 bytes)",
    ...overrides,
  };
}

function props(overrides: Partial<CloudsSettingsPageViewProps> = {}): CloudsSettingsPageViewProps {
  return {
    companyId: COMPANY_ID,
    accounts: [],
    roots: [],
    grants: [],
    journal: [],
    loading: false,
    error: null,
    notice: null,
    pending: false,
    onConnect: vi.fn(),
    onDisconnect: vi.fn(),
    onAddRoot: vi.fn(),
    onRemoveRoot: vi.fn(),
    onSetGrant: vi.fn(),
    onRemoveGrant: vi.fn(),
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
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

function render(node: ReactNode) {
  act(() => root.render(node));
}

function testId(id: string): Element | null {
  return container.querySelector(`[data-testid="${id}"]`);
}

function click(node: Element | null) {
  act(() => {
    node?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function choose(node: Element | null, value: string) {
  act(() => {
    const select = node as HTMLSelectElement;
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function type(node: Element | null, value: string) {
  act(() => {
    const input = node as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("CloudsSettingsPageView", () => {
  it("offers Connect for a cloud with no account and Disconnect for a connected one", () => {
    const onConnect = vi.fn();
    const onDisconnect = vi.fn();
    render(
      <CloudsSettingsPageView
        {...props({
          accounts: [account()],
          onConnect,
          onDisconnect,
        })}
      />,
    );

    expect(testId("myrmidon-clouds-provider-state-onedrive")?.textContent).toContain("Connected as Owner OneDrive");
    expect(testId("myrmidon-clouds-connect-onedrive")).toBeNull();
    expect(testId("myrmidon-clouds-provider-state-google-drive")?.textContent).toContain("Not connected");

    click(testId("myrmidon-clouds-connect-google-drive"));
    expect(onConnect).toHaveBeenCalledWith("google-drive");

    click(testId("myrmidon-clouds-disconnect-onedrive"));
    expect(onDisconnect).toHaveBeenCalledWith("account-1");
  });

  it("never shows a token reference to the owner", () => {
    render(<CloudsSettingsPageView {...props({ accounts: [account()] })} />);
    expect(container.textContent).not.toContain("secret-1");
  });

  it("lists the folders and removes the chosen one", () => {
    const onRemoveRoot = vi.fn();
    render(
      <CloudsSettingsPageView
        {...props({
          roots: [
            root_(),
            root_({ id: "root-shared", name: "shared", kind: "shared", folder: null, driveId: "drive-x", itemId: "item-y" }),
          ],
          onRemoveRoot,
        })}
      />,
    );

    const rows = container.querySelectorAll('[data-testid="myrmidon-clouds-root-row"]');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("work");
    expect(rows[0]?.textContent).toContain("Agents/agent-a");
    expect(rows[1]?.textContent).toContain("shared with us (read only)");

    click(testId("myrmidon-clouds-remove-root-root-shared"));
    expect(onRemoveRoot).toHaveBeenCalledWith("root-shared");
  });

  it("grants a folder to one agent with the chosen mode", () => {
    const onSetGrant = vi.fn();
    render(<CloudsSettingsPageView {...props({ roots: [root_()], onSetGrant })} />);

    choose(testId("myrmidon-clouds-grant-target"), "agent");
    type(testId("myrmidon-clouds-grant-agent"), "agent-a");
    choose(testId("myrmidon-clouds-grant-mode"), "rw");
    click(testId("myrmidon-clouds-add-grant-button"));

    expect(onSetGrant).toHaveBeenCalledWith({
      rootId: "root-work",
      targetKind: "agent",
      agentId: "agent-a",
      mode: "rw",
    });
  });

  it("grants a folder to everyone without asking for an id", () => {
    const onSetGrant = vi.fn();
    render(<CloudsSettingsPageView {...props({ roots: [root_()], onSetGrant })} />);

    choose(testId("myrmidon-clouds-grant-mode"), "ro");
    click(testId("myrmidon-clouds-add-grant-button"));

    expect(onSetGrant).toHaveBeenCalledWith({ rootId: "root-work", targetKind: "all", mode: "ro" });
  });

  it("spells out who each grant is for and removes it", () => {
    const onRemoveGrant = vi.fn();
    render(
      <CloudsSettingsPageView
        {...props({
          roots: [root_()],
          grants: [
            grant(),
            grant({ id: "grant-2", targetKind: "caste", agentId: null, caste: "builders", mode: "ro" }),
            grant({ id: "grant-3", targetKind: "all", agentId: null, mode: "ro", rootId: "root-work" }),
          ],
          onRemoveGrant,
        })}
      />,
    );

    const rows = container.querySelectorAll('[data-testid="myrmidon-clouds-grant-row"]');
    expect(rows).toHaveLength(3);
    expect(rows[0]?.textContent).toContain("work · agent agent-a · read and write");
    expect(rows[1]?.textContent).toContain("caste builders · read only");
    expect(rows[2]?.textContent).toContain("everyone · read only");

    click(testId("myrmidon-clouds-remove-grant-grant-2"));
    expect(onRemoveGrant).toHaveBeenCalledWith("grant-2");
  });

  it("shows the journal, refusals included, and nothing else", () => {
    render(
      <CloudsSettingsPageView
        {...props({
          journal: [
            journalEntry(),
            journalEntry({ id: "entry-2", ok: false, tool: "cloud_list", rootName: "secret", detail: 'no access to folder "secret"' }),
          ],
        })}
      />,
    );

    const entries = container.querySelectorAll('[data-testid="myrmidon-clouds-journal-entry"]');
    expect(entries).toHaveLength(2);
    expect(entries[0]?.textContent).toContain("cloud_upload");
    expect(entries[0]?.textContent).toContain("ok");
    expect(entries[1]?.textContent).toContain("refused");
    expect(entries[1]?.textContent).toContain("no access to folder");
  });

  it("shows empty states and surfaces an error", () => {
    render(<CloudsSettingsPageView {...props({ error: "the cloud refused the authorization" })} />);
    expect(testId("myrmidon-clouds-roots-empty")).not.toBeNull();
    expect(testId("myrmidon-clouds-grants-empty")).not.toBeNull();
    expect(testId("myrmidon-clouds-journal-empty")).not.toBeNull();
    expect(testId("myrmidon-clouds-error")?.textContent).toContain("the cloud refused the authorization");
  });

  it("disables the owner actions while a request is in flight", () => {
    render(<CloudsSettingsPageView {...props({ roots: [root_()], pending: true })} />);
    expect((testId("myrmidon-clouds-connect-onedrive") as HTMLButtonElement).disabled).toBe(true);
    expect((testId("myrmidon-clouds-add-grant-button") as HTMLButtonElement).disabled).toBe(true);
  });
});