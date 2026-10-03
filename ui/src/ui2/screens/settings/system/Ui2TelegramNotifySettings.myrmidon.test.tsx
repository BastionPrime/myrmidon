// ui/src/ui2/screens/settings/system/Ui2TelegramNotifySettings.myrmidon.test.tsx
//
// myrmidon(OPE-3789): guard for the Telegram notifications panel
// (TG-NOTIFY-SETTINGS part F). The server core (part A, pull request 392) is not
// merged yet, so the JSON contract is mocked here: the API module is
// replaced and the tests assert the wire shape the core serves —
// GET answers { settings, changelog } with every field of every section
// always present, PATCH takes a partial per-section body and answers the
// same shape. Defaults must render all five sections OFF.

// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Ui2TelegramNotifySettings } from "./Ui2TelegramNotifySettings";
import { Ui2I18nProvider } from "../../../i18n/Ui2I18n";
import type { TelegramNotifySettings } from "@paperclipai/shared";

const mockTelegramNotifyApi = vi.hoisted(() => ({
  get: vi.fn(),
  update: vi.fn(),
}));

vi.mock("@/api/myrmidonTelegramNotify", () => ({
  telegramNotifyApi: mockTelegramNotifyApi,
  telegramNotifyQueryKey: (companyId: string) => ["myrmidon", "telegram-notify", companyId],
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", name: "company-a", issuePrefix: "OPE" },
  }),
}));

const mockGet = mockTelegramNotifyApi.get;
const mockUpdate = mockTelegramNotifyApi.update;

const COMPANY_ID = "company-1";

/** The defaults of the merged core contract: every section OFF. */
function defaultSettings(): TelegramNotifySettings {
  return {
    digest: {
      enabled: false,
      time: "09:00",
      chatId: null,
      topicId: null,
      sections: ["done", "blocked", "needs_decision", "spend"],
    },
    errors: {
      enabled: false,
      chatId: null,
      topicId: null,
      minSeverity: "error",
      maxPerHour: 10,
    },
    inbound: { enabled: false, requireMention: true },
    escalations: {
      enabled: false,
      hours: 24,
      channel: "none",
      chatId: null,
      topicId: null,
    },
    proactivity: { mode: "only_on_owner_request", rarelyMaxPerDay: 3 },
  };
}

async function flushReact() {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  flushSync(() => {});
}

describe("myrmidon(UI2) Ui2TelegramNotifySettings panel", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let queryClient: QueryClient;

  async function renderPanel() {
    root = createRoot(container);
    flushSync(() => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <Ui2I18nProvider initialLocale="en">
            <Ui2TelegramNotifySettings />
          </Ui2I18nProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mockGet.mockResolvedValue({ settings: defaultSettings(), changelog: [] });
    mockUpdate.mockReset();
  });

  afterEach(() => {
    flushSync(() => {
      root?.unmount();
    });
    root = null;
    container.remove();
    vi.clearAllMocks();
  });

  it("renders all five sections off with the contract defaults", async () => {
    await renderPanel();

    expect(mockGet).toHaveBeenCalledWith(COMPANY_ID);

    for (const section of ["digest", "errors", "inbound", "escalations"] as const) {
      const state = container.querySelector(`.ui2-tn-section-head[data-tn-section="${section}"] .ui2-tn-section-state`);
      expect(state?.getAttribute("data-tn-state")).toBe("off");
    }
    // Proactivity has no "enabled" flag: the default mode means "never on its own".
    const proactivityState = container.querySelector(
      `.ui2-tn-section-head[data-tn-section="proactivity"] .ui2-tn-section-state`,
    );
    expect(proactivityState?.getAttribute("data-tn-state")).toBe("off");

    expect(container.querySelector<HTMLInputElement>("#ui2-tn-digest-enabled")?.checked).toBe(false);
  });

  it("sends a PATCH with the changed field and reflects the answer", async () => {
    await renderPanel();

    const digestEnabled = container.querySelector<HTMLInputElement>("#ui2-tn-digest-enabled");
    expect(digestEnabled).not.toBeNull();
    digestEnabled!.click();
    await flushReact();

    const save = container.querySelector<HTMLButtonElement>(".ui2-tn-save");
    expect(save?.disabled).toBe(false);

    const nextSettings = defaultSettings();
    nextSettings.digest.enabled = true;
    const nextChangelog = [
      { at: "2026-10-03T10:00:00.000Z", actor: "user-1", field: "digest.enabled", from: false, to: true },
    ];
    mockUpdate.mockResolvedValue({ settings: nextSettings, changelog: nextChangelog });

    save!.click();
    await flushReact();

    expect(mockUpdate).toHaveBeenCalledTimes(1);
    const [calledCompanyId, patch] = mockUpdate.mock.calls[0]!;
    expect(calledCompanyId).toBe(COMPANY_ID);
    // Only the changed field is sent, with only the changed section present.
    expect(patch).toEqual({ digest: { enabled: true } });

    // The answer is reflected: the section flips to on.
    const state = container.querySelector(`.ui2-tn-section-head[data-tn-section="digest"] .ui2-tn-section-state`);
    expect(state?.getAttribute("data-tn-state")).toBe("on");
    expect(save?.disabled).toBe(true);
  });

  it("renders the settings change log from the GET answer", async () => {
    mockGet.mockResolvedValue({
      settings: defaultSettings(),
      changelog: [
        { at: "2026-10-03T10:00:00.000Z", actor: "user-1", field: "errors.maxPerHour", from: 10, to: 20 },
        { at: "2026-10-02T09:00:00.000Z", actor: "agent-7", field: "digest.enabled", from: false, to: true },
      ],
    });
    await renderPanel();

    const entries = container.querySelectorAll(".ui2-tn-changelog-entry");
    expect(entries.length).toBe(2);

    const first = entries[0]!;
    expect(first.querySelector(".ui2-tn-changelog-field")?.textContent).toBe("errors.maxPerHour");
    expect(first.querySelector(".ui2-tn-changelog-change")?.textContent).toContain("10");
    expect(first.querySelector(".ui2-tn-changelog-change")?.textContent).toContain("20");
    expect(first.querySelector(".ui2-tn-changelog-meta")?.textContent).toContain("user-1");
  });

  it("shows the denied state when GET answers 403", async () => {
    const error = new Error("Forbidden") as Error & { status?: number };
    error.status = 403;
    mockGet.mockRejectedValue(error);
    await renderPanel();

    expect(container.textContent).toContain("This section needs board access");
  });

  it("surfaces a save failure inline", async () => {
    await renderPanel();

    const digestEnabled = container.querySelector<HTMLInputElement>("#ui2-tn-digest-enabled");
    digestEnabled!.click();
    await flushReact();

    mockUpdate.mockRejectedValue(new Error("Invalid telegram-notify settings"));
    container.querySelector<HTMLButtonElement>(".ui2-tn-save")!.click();
    await flushReact();

    const alert = container.querySelector(".ui2-tn-save-error");
    expect(alert?.textContent).toContain("Invalid telegram-notify settings");
    // The draft survives the failure: the field stays dirty.
    expect(digestEnabled!.checked).toBe(true);
  });
});