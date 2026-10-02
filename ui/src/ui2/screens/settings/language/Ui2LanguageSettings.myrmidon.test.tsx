// ui/src/ui2/screens/settings/language/Ui2LanguageSettings.myrmidon.test.tsx
//
// myrmidon(UI2): screen guard for Settings → Language. The screen embeds
// the shared language-switch module at the agreed import path `ui2/i18n/LanguageSwitch`
// (local implementation until that part merges — the import-path contract
// is exactly what this guard pins: renaming the module or path fails here).
// The catalog switches language as a whole; the preview re-renders in RU.

// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Ui2LanguageSettings } from "./Ui2LanguageSettings";
import { Ui2I18nProvider } from "../../../i18n/Ui2I18n";
import { formatUi2Message } from "../../../i18n/locales";

async function flushReact() {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  flushSync(() => {});
}

describe("myrmidon(UI2) Ui2LanguageSettings screen parity", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  afterEach(() => {
    flushSync(() => {
      root?.unmount();
    });
    root = null;
    container.remove();
    window.localStorage.clear();
  });

  it("embeds the LanguageSwitch module at the agreed ui2/i18n path", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    flushSync(() => {
      root!.render(
        <Ui2I18nProvider initialLocale="en">
          <Ui2LanguageSettings />
        </Ui2I18nProvider>,
      );
    });
    await flushReact();

    // The switch renders the two locale self-names as radio options.
    const options = [...container.querySelectorAll(".ui2-language-switch-option")];
    expect(options.length).toBe(2);
    expect(options[0]?.textContent).toContain("English");
    expect(options[1]?.textContent).toContain("Русский");
  });

  it("switches the whole catalog to RU and back to EN", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    flushSync(() => {
      root!.render(
        <Ui2I18nProvider initialLocale="en">
          <Ui2LanguageSettings />
        </Ui2I18nProvider>,
      );
    });
    await flushReact();

    const ruOption = [...container.querySelectorAll<HTMLButtonElement>(".ui2-language-switch-option")].find(
      (button) => button.textContent?.includes("Русский"),
    );
    ruOption?.click();
    await flushReact();

    expect(window.localStorage.getItem("myrmidon.ui2.locale")).toBe("ru");
    // The preview card re-rendered in Russian.
    expect(container.textContent).toContain("Поднять мягкий лимит на день");

    const enOption = [...container.querySelectorAll<HTMLButtonElement>(".ui2-language-switch-option")].find(
      (button) => button.textContent?.includes("English"),
    );
    enOption?.click();
    await flushReact();
    expect(container.textContent).toContain("Raise the soft limit for the day");
  });

  it("formats the preview metadata through the same helper the screens use", () => {
    expect(formatUi2Message("Prepared by {{agent}}", { agent: "agent-a" })).toBe("Prepared by agent-a");
    expect(formatUi2Message("Ждёт {{age}}", { age: "2h" })).toBe("Ждёт 2h");
  });
});
