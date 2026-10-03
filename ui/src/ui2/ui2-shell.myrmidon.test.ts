// myrmidon(UI2-SHELL): guard test for the UI-2.0 shell contract — the flag
// wiring, the clean-room boundary, the integration contracts with UI-0b
// (Ui2Root mount line, lang-attribute font switch) and UI-0c (the route
// table's six placeholder entries), and the token-gate scope extension.
//
// The server-side normalization of the flag lives in
// server/src/__tests__/instance-settings-service.test.ts (same package as
// the function under test).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { INSTANCE_FEATURE_CATALOG, instanceExperimentalSettingsSchema } from "@paperclipai/shared";

const HERE = dirname(fileURLToPath(import.meta.url));
const UI_SRC = join(HERE, "..");
const REPO_ROOT = join(UI_SRC, "..", "..");

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
    // The single sanctioned mount point: App.tsx imports the hook, the root
    // and the placeholder routes.
    expect(offenders.map((f) => f.split("src").pop())).toEqual(["/App.tsx"]);
  });

  it("index.css imports the ui2 token layer exactly once", () => {
    const css = readFileSync(join(UI_SRC, "index.css"), "utf8");
    expect(css.match(/@import\s+["']\.\/ui2\/theme\/tokens\.css["']/g)?.length).toBe(1);
  });

  it("App.tsx carries the UI2-SHELL mount marker", () => {
    const app = readFileSync(join(UI_SRC, "App.tsx"), "utf8");
    expect(app).toMatch(/myrmidon\(UI2-SHELL\):\s*mount the ui2 shell behind the instance flag/);
  });
});

describe("ui2 integration contracts (UI-0b / UI-0c)", () => {
  it("the route table exposes the six UI-0c entries plus the real Commander chat screen (1.6)", async () => {
    // myrmidon(1.6-CTO-CHAT-A): importing routes.tsx now also pulls in the
    // real Commander chat screen (api client, react-query, auth) — give the
    // module graph more than the default 5s to load.
    const { UI2_ROUTE_TABLE } = await import("./routes");
    expect(UI2_ROUTE_TABLE.map((e) => e.key).sort()).toEqual([
      "agent-overview",
      "commander-chat",
      "costs",
      "decisions",
      "settings-language",
      "settings-runs-queue",
      "settings-system",
    ]);
    for (const entry of UI2_ROUTE_TABLE) {
      expect(entry.element, entry.key).toBeTruthy();
      expect(entry.titleKey.startsWith("ui2.screens."), entry.key).toBe(true);
    }
  }, 30_000);

  it("Ui2Root exists and mounts the shell (UI-0b's provider line)", async () => {
    const mod = await import("./Ui2Root");
    expect(typeof mod.Ui2Root).toBe("function");
    const root = mod.Ui2Root({} as never);
    expect(root).toBeTruthy();
  });

  it("the theme keys the RU display-font switch on [lang=ru] and keeps the wordmark font", () => {
    const css = readFileSync(join(UI_SRC, "ui2", "theme", "tokens.css"), "utf8");
    expect(css).toMatch(/\.myr-ui2\[lang="ru"\]/);
    expect(css).toMatch(/--myr-font-wordmark:\s*"Saira"/);
    // Resolved design-decision values (02.10 board comment) are real, not placeholders.
    expect(css).toMatch(/--myr-signal-warn:\s*#8a5300/);
    expect(css).toMatch(/--myr-warn-bar:\s*#e6b450/);
    expect(css).toMatch(/--myr-edge:\s*#74849a/);
    expect(css).toMatch(/--myr-navy-deep:\s*#13294b/);
    expect(css).toMatch(/--myr-surface:\s*#111922/); // dark
  });

  it("token gates cover the ui2 tree (lead annex)", () => {
    const gate = readFileSync(join(REPO_ROOT, "scripts", "check-token-gates.mjs"), "utf8");
    expect(gate).toMatch(/SCAN_DIRS\s*=\s*\[[^\]]*"ui2"/);
  });

  it("fonts are self-hosted with four subsets per family (no CDN)", () => {
    const fontsDir = join(REPO_ROOT, "ui", "public", "fonts", "myr2");
    const files = readdirSync(fontsDir).filter((f) => f.endsWith(".woff2"));
    const families = new Set(files.map((f) => f.split("-")[0]));
    expect([...families].sort()).toEqual(["exo2", "inter", "jbmono", "saira"]);
    for (const family of ["saira", "jbmono", "inter"]) {
      for (const subset of ["latin", "latin-ext"]) {
        expect(files.some((f) => f.startsWith(`${family}-${subset}-`)), `${family} ${subset}`).toBe(true);
      }
    }
    for (const family of ["exo2", "jbmono", "inter"]) {
      for (const subset of ["cyrillic", "cyrillic-ext"]) {
        expect(files.some((f) => f.startsWith(`${family}-${subset}-`)), `${family} ${subset}`).toBe(true);
      }
    }
    // No external font URLs in the token layer.
    const css = readFileSync(join(UI_SRC, "ui2", "theme", "tokens.css"), "utf8");
    expect(css).not.toMatch(/https?:\/\/[^"')]*fonts\./);
  });
});

describe("ui2 personal override (?ui=1|2)", () => {
  it("parses the override from a query string and remembers it via storage", async () => {
    const mod = await import("./useMyrmidonUi2Enabled");
    expect(mod.ui2OverrideFromSearch("?ui=2")).toBe("2");
    expect(mod.ui2OverrideFromSearch("?ui=1")).toBe("1");
    expect(mod.ui2OverrideFromSearch("")).toBeNull();
    expect(mod.ui2OverrideFromSearch("?ui=3")).toBeNull();

    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k),
      clear: () => store.clear(),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() {
        return store.size;
      },
    };
    expect(mod.readUi2PersonalOverride(storage)).toBeNull();
    mod.rememberUi2PersonalOverride("2", storage);
    expect(mod.readUi2PersonalOverride(storage)).toBe("2");
    mod.rememberUi2PersonalOverride(null, storage);
    expect(mod.readUi2PersonalOverride(storage)).toBeNull();
  });
});

describe("ui2 i18n", () => {
  it("has the ui2 namespace in en and ru with the shell and screen keys", () => {
    const en = JSON.parse(readFileSync(join(UI_SRC, "i18n", "locales", "en.json"), "utf8"));
    const ru = JSON.parse(readFileSync(join(UI_SRC, "i18n", "locales", "ru.json"), "utf8"));
    for (const messages of [en, ru]) {
      expect(messages.ui2).toBeDefined();
      expect(messages.ui2.nav.center).toBeTruthy();
      expect(messages.ui2.nav.commander).toBeTruthy();
      expect(messages.ui2.commander.placeholder).toBeTruthy();
      expect(messages.ui2.nests.all).toBeTruthy();
      expect(messages.ui2.screens.placeholderTitle).toBeTruthy();
      expect(messages.ui2.settings.general).toBeTruthy();
    }
  });

  it("carries Russian, not copied English, for the primary nav labels", () => {
    const ru = JSON.parse(readFileSync(join(UI_SRC, "i18n", "locales", "ru.json"), "utf8"));
    expect(ru.ui2.nav.center).toBe("Командный центр");
    expect(ru.ui2.nav.commander).toBe("Полководец");
    expect(ru.ui2.nav.waiting).toBe("Ждёт меня");
  });
});
