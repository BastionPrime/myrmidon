// @vitest-environment jsdom

// myrmidon(SC1): the panel section that opens the browser console.
//
// The view is checked without a network: the tests pin what the owner sees
// (the node list, the Console button, the terminal frame with the signed token)
// and what the form sends to the registry.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FleetConsolePanelView } from "./FleetConsolePanel";
import { describeServerTarget, secondsUntil, type ConsoleToken, type FleetServer } from "./fleetConsoleApi";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.parse("2026-09-30T08:00:00.000Z");

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

function byId(id: string) {
  return container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
}

function server(overrides: Partial<FleetServer> = {}): FleetServer {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    slug: "node-a",
    name: "Node A",
    hostname: "192.0.2.10",
    port: 22,
    protocol: "ssh",
    username: "fleet-console",
    passwordSecretKey: null,
    description: null,
    enabled: true,
    createdAt: "2026-09-30T07:00:00.000Z",
    updatedAt: "2026-09-30T07:00:00.000Z",
    ...overrides,
  };
}

function token(overrides: Partial<ConsoleToken> = {}): ConsoleToken {
  return {
    sessionId: "55555555-5555-4555-8555-555555555555",
    serverId: "44444444-4444-4444-8444-444444444444",
    serverSlug: "node-a",
    serverName: "Node A",
    protocol: "ssh",
    token: "signed-blob",
    guacamoleUrl: "https://guac.example.com",
    consoleUrl: "https://guac.example.com/#/?data=signed-blob",
    expiresAt: new Date(NOW + 120_000).toISOString(),
    ...overrides,
  };
}

function setText(input: HTMLElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function click(element: HTMLElement | null | undefined) {
  act(() => element!.click());
}

function renderView(overrides: Partial<Parameters<typeof FleetConsolePanelView>[0]> = {}) {
  const props = {
    servers: [server()],
    activeToken: null,
    loading: false,
    pending: false,
    error: null,
    onOpenConsole: vi.fn(),
    onCloseSession: vi.fn(),
    onRegister: vi.fn(),
    nowMs: NOW,
    ...overrides,
  };
  act(() => root.render(<FleetConsolePanelView {...props} />));
  return props;
}

describe("FleetConsolePanelView", () => {
  it("says so when the registry is empty", () => {
    renderView({ servers: [] });
    expect(byId("fleet-console-empty")).not.toBeNull();
    expect(byId("fleet-console-server-node-a")).toBeNull();
  });

  it("lists a node with its target and opens the console on click", () => {
    const props = renderView();
    const row = byId("fleet-console-server-node-a");
    expect(row?.textContent).toContain("Node A");
    expect(row?.textContent).toContain("ssh · 192.0.2.10:22 · fleet-console");
    click(byId("fleet-console-open-node-a"));
    expect(props.onOpenConsole).toHaveBeenCalledWith(expect.objectContaining({ slug: "node-a" }));
  });

  it("keeps a disabled node closed", () => {
    renderView({ servers: [server({ enabled: false })] });
    expect(byId("fleet-console-server-node-a")?.textContent).toContain("disabled");
    expect((byId("fleet-console-open-node-a") as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows the failure the panel returned, for example when the visitor is not the owner", () => {
    renderView({ error: "Company owner access required" });
    expect(container.textContent).toContain("Company owner access required");
  });

  it("renders the terminal frame with the signed token and a way to close the session", () => {
    const props = renderView({ activeToken: token() });
    const frame = byId("fleet-console-terminal") as HTMLIFrameElement;
    expect(frame.getAttribute("src")).toBe("https://guac.example.com/#/?data=signed-blob");
    expect(frame.getAttribute("title")).toBe("Console: Node A");
    expect(byId("fleet-console-session")?.textContent).toContain("Token expires in 120 s");
    expect(byId("fleet-console-new-tab")?.getAttribute("href")).toBe("https://guac.example.com/#/?data=signed-blob");
    click(byId("fleet-console-close"));
    expect(props.onCloseSession).toHaveBeenCalledTimes(1);
  });

  it("sends a registered node with the protocol defaults", () => {
    const props = renderView();
    setText(byId("fleet-console-register-slug")!, "node-b");
    setText(byId("fleet-console-register-name")!, "Node B");
    setText(byId("fleet-console-register-host")!, "192.0.2.11");
    setText(byId("fleet-console-register-secret")!, "node-b-password");
    click(byId("fleet-console-register-submit"));
    expect(props.onRegister).toHaveBeenCalledWith({
      slug: "node-b",
      name: "Node B",
      hostname: "192.0.2.11",
      protocol: "ssh",
      passwordSecretKey: "node-b-password",
    });
  });

  it("does not submit an incomplete row", () => {
    const props = renderView();
    setText(byId("fleet-console-register-slug")!, "node-b");
    click(byId("fleet-console-register-submit"));
    expect(props.onRegister).not.toHaveBeenCalled();
    expect((byId("fleet-console-register-submit") as HTMLButtonElement).disabled).toBe(true);
  });

  it("refuses a port outside the valid range", () => {
    const props = renderView();
    setText(byId("fleet-console-register-slug")!, "node-b");
    setText(byId("fleet-console-register-name")!, "Node B");
    setText(byId("fleet-console-register-host")!, "192.0.2.11");
    setText(byId("fleet-console-register-port")!, "70000");
    expect(container.textContent).toContain("Port must be between 1 and 65535.");
    click(byId("fleet-console-register-submit"));
    expect(props.onRegister).not.toHaveBeenCalled();
  });
});

describe("fleetConsoleApi helpers", () => {
  it("describes the target of a row", () => {
    expect(describeServerTarget({ hostname: "192.0.2.10", port: 22 })).toBe("192.0.2.10:22");
  });

  it("counts the seconds a token has left, and never goes below zero", () => {
    expect(secondsUntil(new Date(NOW + 120_000).toISOString(), NOW)).toBe(120);
    expect(secondsUntil(new Date(NOW - 1_000).toISOString(), NOW)).toBe(0);
    expect(secondsUntil("not-a-date", NOW)).toBe(0);
  });
});