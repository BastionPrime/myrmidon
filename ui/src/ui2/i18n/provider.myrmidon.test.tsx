// @vitest-environment jsdom
// myrmidon(UI2-I18N): tests for the 2.0 UI language provider — catalog
// registration, server preference load, switch with persistence, the lang
// attribute font contract, localStorage fallback and the honest failure path.
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.hoisted(() => ({
  get: vi.fn().mockResolvedValue({ language: "en", updatedAt: null }),
  put: vi.fn().mockResolvedValue({ language: "en", updatedAt: null }),
}));

vi.mock("@/api/client", () => ({ api: apiMock }));

const i18nMock = vi.hoisted(() => ({
  changeLanguage: vi.fn().mockResolvedValue(undefined),
  language: "en",
  addResourceBundle: vi.fn(),
  hasResourceBundle: vi.fn().mockReturnValue(false),
}));

vi.mock("@/i18n", () => ({ i18n: i18nMock }));

import { Ui2LanguageProvider, useUi2Language } from "./index";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/** Repo's act pattern: flush the callback sync, then await its result. */
async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

let container: HTMLDivElement;
let shellRoot: HTMLDivElement;
let root: Root | null;
let probe: { language: string; saving: boolean; saveError: boolean };
let setLanguageFn: ((language: "en" | "ru") => void) | null = null;

function Probe() {
  const value = useUi2Language();
  probe = { language: value.language, saving: value.saving, saveError: value.saveError };
  setLanguageFn = value.setLanguage;
  return null;
}

function renderTree() {
  root = createRoot(container);
  flushSync(() => {
    root?.render(
      <Ui2LanguageProvider>
        <Probe />
      </Ui2LanguageProvider>,
    );
  });
}

beforeEach(() => {
  container = document.createElement("div");
  // The ui2 root element the shell mounts: the provider sets `lang` on it.
  shellRoot = document.createElement("div");
  shellRoot.className = "myr-ui2";
  document.body.appendChild(shellRoot);
  document.body.appendChild(container);
  window.localStorage.clear();
  apiMock.get.mockReset().mockResolvedValue({ language: "en", updatedAt: null });
  apiMock.put.mockReset().mockResolvedValue({ language: "en", updatedAt: null });
  i18nMock.changeLanguage.mockClear();
  i18nMock.addResourceBundle.mockClear();
  i18nMock.hasResourceBundle.mockReset().mockReturnValue(false);
  i18nMock.language = "en";
  shellRoot.removeAttribute("lang");
  document.documentElement.lang = "en";
  probe = { language: "en", saving: false, saveError: false };
  setLanguageFn = null;
});

afterEach(() => {
  flushSync(() => root?.unmount());
  container.remove();
  shellRoot.remove();
  vi.clearAllMocks();
});

describe("Ui2LanguageProvider catalog registration", () => {
  it("registers the en and ru ui2 catalogs via addResourceBundle", async () => {
    renderTree();
    await act(() => undefined);
    expect(i18nMock.addResourceBundle).toHaveBeenCalledWith("en", "ui2", expect.anything(), true, true);
    expect(i18nMock.addResourceBundle).toHaveBeenCalledWith("ru", "ui2", expect.anything(), true, true);
  });

  it("does not re-register catalogs that are already present", async () => {
    i18nMock.hasResourceBundle.mockReset().mockReturnValue(true);
    renderTree();
    await act(() => undefined);
    expect(i18nMock.addResourceBundle).not.toHaveBeenCalled();
  });
});

describe("Ui2LanguageProvider", () => {
  it("loads the server preference and applies it", async () => {
    apiMock.get.mockResolvedValue({ language: "ru", updatedAt: "2026-10-02T00:00:00.000Z" });
    renderTree();
    await vi.waitFor(() => expect(probe.language).toBe("ru"));
    expect(i18nMock.changeLanguage).toHaveBeenCalledWith("ru");
    expect(shellRoot.getAttribute("lang")).toBe("ru");
    expect(window.localStorage.getItem("myrmidon:ui2:language")).toBe("ru");
  });

  it("starts from the local mirror before the server resolves", () => {
    window.localStorage.setItem("myrmidon:ui2:language", "ru");
    renderTree();
    expect(probe.language).toBe("ru");
  });

  it("switches the language, persists locally and writes the server copy", async () => {
    renderTree();
    apiMock.put.mockResolvedValue({ language: "ru", updatedAt: "2026-10-02T00:00:00.000Z" });
    expect(setLanguageFn).not.toBeNull();
    await act(() => {
      setLanguageFn!("ru");
    });
    expect(probe.language).toBe("ru");
    expect(apiMock.put).toHaveBeenCalledWith("/myrmidon/ui2/language/me", { language: "ru" });
    expect(i18nMock.changeLanguage).toHaveBeenCalledWith("ru");
    expect(shellRoot.getAttribute("lang")).toBe("ru");
    expect(window.localStorage.getItem("myrmidon:ui2:language")).toBe("ru");
  });

  it("keeps the choice applied when the server write fails, and flags it", async () => {
    renderTree();
    apiMock.put.mockRejectedValue(new Error("offline"));
    expect(setLanguageFn).not.toBeNull();
    await act(() => {
      setLanguageFn!("ru");
    });
    await vi.waitFor(() => expect(probe.saveError).toBe(true));
    expect(probe.language).toBe("ru");
    expect(window.localStorage.getItem("myrmidon:ui2:language")).toBe("ru");
    expect(i18nMock.changeLanguage).toHaveBeenCalledWith("ru");
  });

  it("falls back to en when the server preference is unavailable", async () => {
    apiMock.get.mockRejectedValue(new Error("offline"));
    renderTree();
    await vi.waitFor(() => expect(apiMock.get).toHaveBeenCalled());
    expect(probe.language).toBe("en");
  });

  it("sets lang on documentElement when no .myr-ui2 root exists", async () => {
    shellRoot.remove();
    apiMock.get.mockResolvedValue({ language: "ru", updatedAt: null });
    renderTree();
    await vi.waitFor(() => expect(probe.language).toBe("ru"));
    expect(document.documentElement.getAttribute("lang")).toBe("ru");
  });
});
