// @vitest-environment jsdom
// myrmidon(1.6.1 VOICE-STT C): view-tier tests for the STT settings screen —
// layout, field edits, the diff-on-save rule (only changed fields), secret
// name rendering with the set/unset indicator, and the value-free DOM rule:
// the screen speaks secret NAMES only, so no secret-shaped value can ever
// appear in the rendered tree.
import { act } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { diffFromSettings, formFromSettings, VoiceSttScreenView, type VoiceSttFormState } from "./VoiceSttScreen";
import type { VoiceSttSettings, VoiceSttUpdateInput } from "./voiceSttApi";

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
let onChange: (next: VoiceSttFormState) => void;
let onSave: (input: VoiceSttUpdateInput) => void;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  onChange = vi.fn();
  onSave = vi.fn();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container.remove();
});

function render(settings: VoiceSttSettings = record()) {
  root = createRoot(container);
  flushSync(() => {
    root!.render(
      <VoiceSttScreenView
        settings={settings}
        saving={false}
        error={null}
        dirty
        onChange={onChange}
        onSave={onSave}
      />,
    );
  });
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

async function flushReact() {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  flushSync(() => {});
}

describe("myrmidon(1.6.1 VOICE-STT C) view tier", () => {
  it("renders all fields from the record; secret names show the set/unset indicator", async () => {
    render();
    await flushReact();
    expect(inputByTestId("myrmidon-voice-stt-model").value).toBe("");
    expect(inputByTestId("myrmidon-voice-stt-max-duration").value).toBe("600");
    expect(inputByTestId("myrmidon-voice-stt-key-secret").value).toBe("agent-a/stt-key");
    expect(
      container.querySelector('[data-testid="myrmidon-voice-stt-key-secret-state"]')?.textContent,
    ).toBeTruthy();
    expect(
      container.querySelector('[data-testid="myrmidon-voice-stt-deepgram-secret-state"]')?.textContent,
    ).toBeTruthy();
  });

  it("edits toggle enable, backend, language and diarization and call onChange", async () => {
    render();
    await flushReact();
    await click('[data-testid="myrmidon-voice-stt-enabled"] input');
    await click('[data-testid="myrmidon-voice-stt-diarization"] input');

    const backend = container.querySelector<HTMLSelectElement>('[data-testid="myrmidon-voice-stt-backend"]');
    await act(async () => {
      backend!.value = "deepgram";
      backend!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const language = container.querySelector<HTMLSelectElement>('[data-testid="myrmidon-voice-stt-language"]');
    await act(async () => {
      language!.value = "ru";
      language!.dispatchEvent(new Event("change", { bubbles: true }));
    });

    const calls = (onChange as ReturnType<typeof vi.fn>).mock.calls;
    const last = calls.at(-1)?.[0] as VoiceSttFormState;
    expect(last.enabled).toBe(true);
    expect(last.diarization).toBe(true);
    expect(last.backend).toBe("deepgram");
    expect(last.language).toBe("ru");
  });

  it("save submits only the changed fields (the diff rule)", async () => {
    render();
    await flushReact();
    await typeInto(inputByTestId("myrmidon-voice-stt-model"), "paraformer-x");
    await typeInto(inputByTestId("myrmidon-voice-stt-max-duration"), "1800");
    await click('[data-testid="myrmidon-voice-stt-save"]');
    expect(onSave).toHaveBeenCalledWith({ model: "paraformer-x", maxDurationSec: 1800 });
  });

  it("clearing the model sends null; a cleared secret name sends null", async () => {
    render(record({ model: "paraformer-x" }));
    await flushReact();
    await typeInto(inputByTestId("myrmidon-voice-stt-model"), "");
    await typeInto(inputByTestId("myrmidon-voice-stt-key-secret"), "");
    await click('[data-testid="myrmidon-voice-stt-save"]');
    expect(onSave).toHaveBeenCalledWith({ model: null, keySecret: null });
  });

  it("the set/unset state text reflects the loaded record, not the local edit", async () => {
    render();
    await flushReact();
    const stateBefore = container.querySelector(
      '[data-testid="myrmidon-voice-stt-deepgram-secret-state"]',
    )?.textContent;
    await typeInto(inputByTestId("myrmidon-voice-stt-deepgram-secret"), "agent-a/deepgram");
    // The saved indicator stays "unset" until the server record changes.
    expect(
      container.querySelector('[data-testid="myrmidon-voice-stt-deepgram-secret-state"]')?.textContent,
    ).toBe(stateBefore);
  });

  it("a fresh record after save resets the local form", async () => {
    render();
    await flushReact();
    await typeInto(inputByTestId("myrmidon-voice-stt-model"), "paraformer-x");

    // Simulate the post-save reload: same component, new record object.
    act(() => {
      root!.render(
        <VoiceSttScreenView
          settings={record({ model: "paraformer-x" })}
          saving={false}
          error={null}
          dirty
          onChange={onChange}
          onSave={onSave}
        />,
      );
    });
    await flushReact();
    expect(inputByTestId("myrmidon-voice-stt-model").value).toBe("paraformer-x");
  });

  it("the error banner renders when the container passes one", async () => {
    root = createRoot(container);
    flushSync(() => {
      root!.render(
        <VoiceSttScreenView
          settings={record()}
          saving={false}
          error="Invalid STT settings"
          dirty
          onChange={onChange}
          onSave={onSave}
        />,
      );
    });
    expect(
      container.querySelector('[data-testid="myrmidon-voice-stt-error"]')?.textContent,
    ).toContain("Invalid STT settings");
  });

  it("the DOM stays value-free: no key-shaped literal ever renders", async () => {
    render(record({ keySecret: "agent-a/stt-key", deepgramKeySecret: "agent-a/dg" }));
    await flushReact();
    expect(container.innerHTML).not.toContain("sk-");
    expect(container.innerHTML).not.toMatch(/Bearer\s+[A-Za-z0-9._-]{10,}/);
    // The names themselves are settings and DO travel into the inputs.
    expect(inputByTestId("myrmidon-voice-stt-key-secret").value).toBe("agent-a/stt-key");
    expect(inputByTestId("myrmidon-voice-stt-deepgram-secret").value).toBe("agent-a/dg");
  });
});

describe("diffFromSettings / formFromSettings (unit)", () => {
  it("an unchanged form yields an empty diff", () => {
    const r = record();
    expect(Object.keys(diffFromSettings(formFromSettings(r), r))).toEqual([]);
  });

  it("a whitespace model edit sends the trimmed value", () => {
    const r = record();
    const form: VoiceSttFormState = { ...formFromSettings(r), model: " paraformer-x " };
    expect(diffFromSettings(form, r)).toEqual({ model: "paraformer-x" });
  });

  it("an invalid duration is not part of the diff (the save button guards it)", () => {
    const r = record();
    const form: VoiceSttFormState = { ...formFromSettings(r), maxDurationSec: "abc" };
    expect(diffFromSettings(form, r)).toEqual({});
  });
});
