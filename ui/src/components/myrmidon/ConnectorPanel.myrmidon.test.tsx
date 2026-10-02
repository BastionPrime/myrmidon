// @vitest-environment jsdom
//
// myrmidon(EXTCASE-PANEL): the connector panel view.
//
// Pins, per the acceptance points the panel owns:
//   1. the device list shows status (online/offline), last seen, version and
//      capabilities, and revoking a device takes a confirm step;
//   2. issuing a pairing code surfaces the code exactly once with its expiry;
//   3. the allowlist draft keeps only bare hostnames;
//   4. the signing policy saves mode/types/daily-limit together, the daily
//      limit validates (empty = no limit), and the kill switch is a separate
//      one-shot action;
//   5. the journal table renders the signature fields (action type and the
//      document hash) and the filters switch to signatures-only.

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import { i18n } from "@/i18n";
import {
  ConnectorPanelView,
  parseAllowlistDraft,
  parseDailyLimitDraft,
} from "./ConnectorPanel";
import type { BridgeDeviceView, BridgeJournalRow, BridgeSettings } from "./connectorPanelApi";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

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

const device: BridgeDeviceView = {
  deviceId: "device-0001",
  label: "tender-ops",
  extVersion: "0.1.0",
  capabilities: ["open", "read", "sign"],
  pairedAt: "2026-10-01T08:00:00.000Z",
  lastSeenAt: "2026-10-01T09:59:30.000Z",
  connected: true,
};

const settings: BridgeSettings = {
  domains: ["tender.example", "portal.example"],
  signing: { enabled: true, mode: "types", types: ["tender.submit"], dailyLimit: 5 },
};

const signRow: BridgeJournalRow = {
  id: "row-1",
  createdAt: "2026-10-01T10:00:00.000Z",
  action: "browser_bridge.action.executed",
  deviceId: "device-0001",
  label: null,
  method: "browser.sign",
  url: null,
  target: null,
  outcome: "ok",
  confirmation: "confirmed",
  durationMs: 1200,
  reasonCode: null,
  signActionType: "tender.submit",
  signStatus: "signed",
  documentHash: "b".repeat(64),
  actorType: "agent",
  actorId: "agent-1",
  runId: null,
};

const readRow: BridgeJournalRow = {
  ...signRow,
  id: "row-2",
  method: "browser.read",
  url: "https://tender.example/lot/1",
  outcome: "ok",
  confirmation: "not_required",
  signActionType: null,
  signStatus: null,
  documentHash: null,
};

const NOW = Date.parse("2026-10-01T10:00:00.000Z");

interface Handlers {
  onIssuePairing?: (label?: string) => void;
  onRevokeDevice?: (deviceId: string) => void;
  onSaveSettings?: (patch: { domains: string[]; signing: BridgeSettings["signing"] }) => void;
  onKillSwitch?: () => void;
}

function render(overrides: Partial<Parameters<typeof ConnectorPanelView>[0]> & Handlers = {}) {
  const {
    onIssuePairing,
    onRevokeDevice,
    onSaveSettings,
    onKillSwitch,
    ...props
  } = overrides;
  flushSync(() => {
    root.render(
      <I18nextProvider i18n={i18n}>
        <ConnectorPanelView
          devices={[device]}
          settings={settings}
          journalRows={[signRow, readRow]}
          signedToday={3}
          journalLoading={false}
          pairingPending={false}
          savePending={false}
          killSwitchPending={false}
          revokePending={null}
          lastPairingCode={null}
          error={null}
          nowMs={NOW}
          onIssuePairing={onIssuePairing}
          onRevokeDevice={onRevokeDevice}
          onSaveSettings={onSaveSettings}
          onKillSwitch={onKillSwitch}
          {...props}
        />
      </I18nextProvider>,
    );
  });
}

function findByTestId(id: string): HTMLElement {
  return container.querySelector(`[data-testid="${id}"]`) as HTMLElement;
}

function click(el: Element) {
  flushSync(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function typeInto(el: HTMLInputElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  flushSync(() => {
    setter.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("myrmidon(EXTCASE-PANEL) connector panel view", () => {
  it("renders the device with its online status and last seen", () => {
    render();
    expect(findByTestId("connector-device-status-device-0001").textContent).toBe("Online");
    // lastSeenAt is 30 s before the injected now
    expect(findByTestId("connector-device-lastseen-device-0001").textContent).toBe("30s ago");
    expect(findByTestId("myrmidon-connector-panel").textContent).toContain("tender-ops");
  });

  it("shows an offline device as offline", () => {
    render({ devices: [{ ...device, connected: false, lastSeenAt: null }] });
    expect(findByTestId("connector-device-status-device-0001").textContent).toBe("Offline");
    expect(findByTestId("connector-device-lastseen-device-0001").textContent).toBe("never");
  });

  it("issues a pairing code with the label and shows the code once", () => {
    const onIssuePairing = vi.fn();
    render({ onIssuePairing });
    const labelInput = container.querySelector("#connector-pairing-label") as HTMLInputElement;
    typeInto(labelInput, "reception-pc");
    click([...container.querySelectorAll("button")].find((b) => b.textContent === "Issue pairing code")!);
    expect(onIssuePairing).toHaveBeenCalledWith("reception-pc");

    render({ onIssuePairing, lastPairingCode: { code: "ABCD-EFGH", expiresAt: "2026-10-01T10:15:00.000Z" } });
    expect(findByTestId("connector-panel-pairing-code").textContent).toContain("ABCD-EFGH");
  });

  it("revoking a device needs a confirm step, then calls the handler", () => {
    const onRevokeDevice = vi.fn();
    render({ onRevokeDevice });
    click([...container.querySelectorAll("button")].find((b) => b.textContent === "Revoke")!);
    // The confirm step replaces the row action: the plain revoke is gone.
    click([...container.querySelectorAll("button")].find((b) => b.textContent === "Confirm revoke")!);
    expect(onRevokeDevice).toHaveBeenCalledWith("device-0001");
  });

  it("saves the signing policy: mode, types and the daily limit travel together", () => {
    const onSaveSettings = vi.fn();
    render({ onSaveSettings });
    const mode = findByTestId("connector-signing-mode") as HTMLSelectElement;
    const limit = findByTestId("connector-signing-limit") as HTMLInputElement;
    const types = findByTestId("connector-signing-types") as HTMLInputElement;
    const setter = (el: HTMLInputElement | HTMLSelectElement, value: string) => {
      const proto = el instanceof HTMLSelectElement
        ? Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!
        : Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      flushSync(() => {
        proto.call(el, value);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      });
    };
    // The types input only exists in per-type mode: fill it before switching.
    setter(types, "tender.submit, tender.bid");
    setter(mode, "manual");
    setter(limit, "10");
    click(findByTestId("connector-panel-save"));
    // The allowlist travels normalized (deduplicated, sorted) — the same
    // canonical form the gateway stores.
    expect(onSaveSettings).toHaveBeenCalledWith({
      domains: ["portal.example", "tender.example"],
      signing: {
        enabled: true,
        mode: "manual",
        types: ["tender.submit", "tender.bid"],
        dailyLimit: 10,
      },
    });
  });

  it("an empty daily limit saves as no limit; a bad value blocks the save", () => {
    const onSaveSettings = vi.fn();
    render({ onSaveSettings });
    const limit = findByTestId("connector-signing-limit") as HTMLInputElement;
    typeInto(limit, "");
    click(findByTestId("connector-panel-save"));
    expect(onSaveSettings).toHaveBeenCalledWith(expect.objectContaining({
      signing: expect.objectContaining({ dailyLimit: 0 }),
    }));

    typeInto(limit, "-3");
    expect(findByTestId("connector-signing-limit-error")).not.toBeNull();
    expect((findByTestId("connector-panel-save") as HTMLButtonElement).disabled).toBe(true);
    onSaveSettings.mockClear();
    click(findByTestId("connector-panel-save"));
    expect(onSaveSettings).not.toHaveBeenCalled();
  });

  it("the kill switch is its own action, disabled when signing is already off", () => {
    const onKillSwitch = vi.fn();
    render({ onKillSwitch });
    click(findByTestId("connector-panel-kill-switch"));
    expect(onKillSwitch).toHaveBeenCalled();

    render({ onKillSwitch, settings: { ...settings, signing: { ...settings.signing, enabled: false } } });
    expect((findByTestId("connector-panel-kill-switch") as HTMLButtonElement).disabled).toBe(true);
    expect(findByTestId("connector-panel-signing-off")).not.toBeNull();
  });

  it("the journal renders signature rows with the action type and the document hash", () => {
    render();
    expect(findByTestId("connector-journal-sign-type").textContent).toBe("tender.submit");
    expect(findByTestId("connector-journal-doc-hash").textContent).toContain("b".repeat(16));
    expect(findByTestId("connector-panel-journal-table").textContent).toContain("browser.read");
  });

  it("an empty journal shows the empty state", () => {
    render({ journalRows: [] });
    expect(findByTestId("connector-panel-journal-empty")).not.toBeNull();
  });

  it("shows the signed-today count next to the limit", () => {
    render();
    expect(findByTestId("connector-panel-signed-today").textContent).toContain("3");
  });
});

describe("myrmidon(EXTCASE-PANEL) draft parsers", () => {
  it("keeps only bare hostnames, deduplicated and sorted", () => {
    expect(
      parseAllowlistDraft("Tender.Example\nportal.example, https://evil.example\n*.wild.example\ntender.example\nbad host\n"),
    ).toEqual(["portal.example", "tender.example"]);
  });

  it("parses the daily limit: empty is no limit, a positive integer is the limit", () => {
    expect(parseDailyLimitDraft("")).toEqual({ value: 0, error: null });
    expect(parseDailyLimitDraft(" 7 ")).toEqual({ value: 7, error: null });
    expect(parseDailyLimitDraft("0").value).toBeNull();
    expect(parseDailyLimitDraft("-1").value).toBeNull();
    expect(parseDailyLimitDraft("1.5").value).toBeNull();
  });
});
