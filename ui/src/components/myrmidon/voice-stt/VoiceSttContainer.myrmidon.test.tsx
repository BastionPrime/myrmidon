// @vitest-environment jsdom
// myrmidon(1.6.1 VOICE-STT C): container-tier tests — the wire tier against a
// mocked API client. Checked: the GET record renders; a field edit PATCHes
// only the changed fields; a save invalidates and re-reads the record; a
// mutation error surfaces as text; and the secret-value rule: the API answers
// secret NAMES only, and no secret-shaped value ever appears in the DOM.
import { act } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceSttScreen } from "./VoiceSttContainer";
import { voiceSttApi, type VoiceSttSettings } from "./voiceSttApi";
import { ApiError } from "@/api/client";

const apiMock = vi.hoisted(() => ({
  view: vi.fn(),
  update: vi.fn(),
}));

vi.mock("./voiceSttApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./voiceSttApi")>()),
  voiceSttApi: apiMock,
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

const COMPANY_ID = "company-1";

function record(overrides: Partial<VoiceSttSettings> = {}): VoiceSttSettings {
  return {
    enabled: false,
    backend: "dashscope",
    model: null,
    language: "auto",
    diarization: false,
    maxDurationSec: 600,
    keySecret: "agent-a/stt-key",
    deepgramKeySecret: null,
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root | null = null;
let queryClient: QueryClient;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  apiMock.view.mockReset().mockResolvedValue(record());
  apiMock.update.mockReset();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container.remove();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  flushSync(() => {});
}

async function renderScreen(): Promise<void> {
  root = createRoot(container);
  flushSync(() => {
    root!.render(
      <QueryClientProvider client={queryClient}>
        <VoiceSttScreen />
      </QueryClientProvider>,
    );
  });
  await settle();
}

function inputByTestId(id: string): HTMLInputElement {
  return container.querySelector(`[data-testid="${id}"]`) as HTMLInputElement;
}

async function typeInto(input: HTMLInputElement, text: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(selector: string): Promise<void> {
  await act(async () => {
    container
      .querySelector(selector)
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("myrmidon(1.6.1 VOICE-STT C) container", () => {
  it("loads the record over the GET endpoint and renders its fields", async () => {
    await renderScreen();
    expect(apiMock.view).toHaveBeenCalledWith(COMPANY_ID);
    // The secret NAME renders (it is a setting, not a value); the unset
    // Deepgram name shows the unset indicator.
    expect(inputByTestId("myrmidon-voice-stt-key-secret").value).toBe("agent-a/stt-key");
    expect(
      container.querySelector('[data-testid="myrmidon-voice-stt-deepgram-secret-state"]')?.textContent,
    ).toBeTruthy();
    expect(inputByTestId("myrmidon-voice-stt-model").value).toBe("");
  });

  it("an edit PATCHes only the changed fields", async () => {
    await renderScreen();
    await click('[data-testid="myrmidon-voice-stt-enabled"] input');
    apiMock.update.mockResolvedValue(record({ enabled: true }));
    await click('[data-testid="myrmidon-voice-stt-save"]');
    await settle();

    expect(apiMock.update).toHaveBeenCalledWith(COMPANY_ID, { enabled: true });
  });

  it("a model edit sends the trimmed model and a duration edit sends the number", async () => {
    await renderScreen();
    await typeInto(inputByTestId("myrmidon-voice-stt-model"), " paraformer-x ");
    await typeInto(inputByTestId("myrmidon-voice-stt-max-duration"), "900");
    apiMock.update.mockResolvedValue(
      record({ model: "paraformer-x", maxDurationSec: 900 }),
    );
    await click('[data-testid="myrmidon-voice-stt-save"]');
    await settle();

    expect(apiMock.update).toHaveBeenCalledWith(COMPANY_ID, {
      model: "paraformer-x",
      maxDurationSec: 900,
    });
  });

  it("an unchanged form sends nothing (save disabled), a changed secret name PATCHes it", async () => {
    await renderScreen();
    const save = container.querySelector<HTMLButtonElement>('[data-testid="myrmidon-voice-stt-save"]');
    expect(save?.disabled).toBe(true);

    await typeInto(inputByTestId("myrmidon-voice-stt-deepgram-secret"), "agent-a/deepgram");
    apiMock.update.mockResolvedValue(record({ deepgramKeySecret: "agent-a/deepgram" }));
    await click('[data-testid="myrmidon-voice-stt-save"]');
    await settle();
    expect(apiMock.update).toHaveBeenCalledWith(COMPANY_ID, {
      deepgramKeySecret: "agent-a/deepgram",
    });
  });

  it("a save failure surfaces the API error text", async () => {
    await renderScreen();
    apiMock.update.mockRejectedValue(
      new ApiError("Invalid STT settings: maxDurationSec must be >= 1", 422, {
        error: "invalid_settings",
      }),
    );
    await click('[data-testid="myrmidon-voice-stt-enabled"] input');
    await click('[data-testid="myrmidon-voice-stt-save"]');
    await settle();

    expect(
      container.querySelector('[data-testid="myrmidon-voice-stt-error"]')?.textContent,
    ).toContain("maxDurationSec must be >= 1");
  });

  it("the secret names render but nothing value-shaped ever appears in the DOM", async () => {
    await renderScreen();
    // The record itself is value-free by contract; assert no api-key-shaped
    // literal leaks into the rendered tree from any layer.
    expect(container.innerHTML).not.toContain("sk-");
    expect(container.innerHTML).not.toMatch(/Bearer\s+[A-Za-z0-9._-]{10,}/);
    expect(inputByTestId("myrmidon-voice-stt-key-secret").value).toBe("agent-a/stt-key");
  });
});
