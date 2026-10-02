// myrmidon(UI-0a): guard test for the UI-2.0 shell contract — the flag wiring
// across the stack. Covers:
//   1. the experimental settings schema defaults enableMyrmidonUi2 to false;
//   2. the feature catalog entry exists with the preference tier and a
//      self-hosted default that matches the schema;
//   3. the shell is the ONLY vendor file that references the ui2 tree — the
//      clean-room boundary (owner 02.10): no other vendor file under ui/src
//      may import from ui2, and App.tsx references it exactly as the shell
//      mount;
//   4. i18n: the ui2.* namespace exists in en and ru, and ru carries real
//      Russian (not copied English) for the primary nav labels.
// The server-side normalization of the flag lives in
// server/src/__tests__/instance-settings-service.test.ts (same package as the
// function under test).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { INSTANCE_FEATURE_CATALOG, instanceExperimentalSettingsSchema } from "@paperclipai/shared";

const HERE = dirname(fileURLToPath(import.meta.url));
const UI_SRC = join(HERE, "..");

describe("enableMyrmidonUi2 flag contract", () => {
  it("defaults to off in the experimental settings schema", () => {
    const defaults = instanceExperimentalSettingsSchema.parse({});
    expect(defaults.enableMyrmidonUi2).toBe(false);
  });

  it("is a preference-tier catalog entry with matching self-hosted default", () => {
    const entry = INSTANCE_FEATURE_CATALOG.enableMyrmidonUi2;
    expect(entry).toBeDefined();
    expect(entry.tier).toBe("preference");
    expect(entry.selfHostedDefault).toBe(false);
    expect(entry.title.trim().length).toBeGreaterThan(0);
    expect(entry.description.trim().length).toBeGreaterThan(0);
  });
});

describe("ui2 clean-room boundary", () => {
  /** Vendor files = everything under ui/src except the ui2 tree itself. */
  function walkVendorFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) {
        if (p === join(UI_SRC, "ui2")) continue;
        walkVendorFiles(p, out);
      } else if (/\.(tsx?|jsx?)$/.test(entry)) {
        out.push(p);
      }
    }
    return out;
  }

  it("only App.tsx (the mount point) references ui2 among vendor files", () => {
    const offenders: string[] = [];
    for (const file of walkVendorFiles(UI_SRC)) {
      const source = readFileSync(file, "utf8");
      if (/from\s+["']\.\/ui2\//.test(source) || /from\s+["']@\/ui2\//.test(source)) {
        offenders.push(file);
      }
    }
    // The single sanctioned mount point: App.tsx imports the hook and the shell.
    expect(offenders.map((f) => f.split("src").pop())).toEqual(["/App.tsx"]);
  });

  it("index.css imports the ui2 token layer exactly once", () => {
    const css = readFileSync(join(UI_SRC, "index.css"), "utf8");
    expect(css.match(/@import\s+["']\.\/ui2\/tokens\.css["']/g)?.length).toBe(1);
  });
});

describe("ui2 i18n", () => {
  it("has the ui2 namespace in en and ru with the shell keys", () => {
    const en = JSON.parse(readFileSync(join(UI_SRC, "i18n", "locales", "en.json"), "utf8"));
    const ru = JSON.parse(readFileSync(join(UI_SRC, "i18n", "locales", "ru.json"), "utf8"));
    for (const messages of [en, ru]) {
      expect(messages.ui2).toBeDefined();
      expect(messages.ui2.nav.center).toBeTruthy();
      expect(messages.ui2.nav.commander).toBeTruthy();
      expect(messages.ui2.commander.placeholder).toBeTruthy();
      expect(messages.ui2.nests.all).toBeTruthy();
    }
  });

  it("carries Russian, not copied English, for the primary nav labels", () => {
    const ru = JSON.parse(readFileSync(join(UI_SRC, "i18n", "locales", "ru.json"), "utf8"));
    expect(ru.ui2.nav.center).toBe("Командный центр");
    expect(ru.ui2.nav.commander).toBe("Полководец");
    expect(ru.ui2.nav.waiting).toBe("Ждёт меня");
  });
});
