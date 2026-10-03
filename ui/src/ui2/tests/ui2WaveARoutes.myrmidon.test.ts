// ui/src/ui2/tests/ui2WaveARoutes.myrmidon.test.ts — UI-2.0 Wave A, part 1
//
// myrmidon(UI-2.0-WAVE-A): guard tests for the honest shell routes
// (OPE-3985, ia-v2 §0/§2.0 rules П1/П2/П5 and checklist §7 items 1–4, 8):
//   - П2: every root of every UI2_ROUTE_TABLE entry is registered, i.e.
//     `extractCompanyPrefixFromPath('/<root>')` returns null — no route
//     root can ever be mistaken for a company prefix (the OPE-3922
//     "COMMANDER-CHAT organization not found" defect);
//   - П1: every shell nav target is company-relative (never starts with
//     an upper-case /{P} literal) and every shell Link goes through the
//     prefixing router;
//   - П5: every rail item and every settings section owns a UNIQUE `to`
//     (no two items on one screen — the double-highlight defect), and
//     the active-item match is a root equality, so at most one item can
//     light up for any pathname;
//   - the fleet "soon" screen is routed on its own root and the hidden
//     settings paths render the "not in this wave" card, not a
//     fall-through.

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractCompanyPrefixFromPath } from "@/lib/company-routes";
import { UI2_NAV_GROUPS, UI2_PHONE_TABS, ui2NavRouteRoot, type Ui2NavItem } from "../navModel";
import {
  UI2_HIDDEN_SETTINGS_PATHS,
  UI2_ROUTE_TABLE,
  ui2RouteEntryRoot,
  ui2ScreenRoutes,
} from "../routes";
import { UI2_SETTINGS_SECTIONS } from "../shell/Ui2SettingsSidebar";

const HERE = dirname(fileURLToPath(import.meta.url));
const UI2_SRC = join(HERE, "..");

function allRailItems(): Ui2NavItem[] {
  return UI2_NAV_GROUPS.flatMap((group) => group.items);
}

describe("myrmidon(UI-2.0-WAVE-A) П2: route roots are registered", () => {
  it("every UI2_ROUTE_TABLE root extracts as null company prefix", () => {
    const roots = new Set(UI2_ROUTE_TABLE.map(ui2RouteEntryRoot));
    expect(roots.size).toBeGreaterThan(0);
    for (const root of roots) {
      expect(
        extractCompanyPrefixFromPath(`/${root}`),
        `root "/${root}" must not be parsed as a company prefix`,
      ).toBeNull();
    }
  });

  it("the wave-A roots the board called out are registered", () => {
    for (const root of ["commander-chat", "commander", "fleet", "quality"]) {
      expect(extractCompanyPrefixFromPath(`/${root}`), root).toBeNull();
    }
  });

  it("every nav-item route root is registered", () => {
    const roots = new Set([...allRailItems(), ...UI2_PHONE_TABS].map(ui2NavRouteRoot));
    for (const root of roots) {
      if (root.startsWith("__")) continue; // synthetic "More" root
      expect(
        extractCompanyPrefixFromPath(`/${root}`),
        `nav root "/${root}" must not be parsed as a company prefix`,
      ).toBeNull();
    }
  });

  it("a real company prefix still extracts (the guard is not vacuous)", () => {
    expect(extractCompanyPrefixFromPath("/OPE/dashboard")).toBe("OPE");
    expect(extractCompanyPrefixFromPath("/ope/fleet")).toBe("OPE");
  });
});

describe("myrmidon(UI-2.0-WAVE-A) П1: company-relative shell targets", () => {
  it("every rail/phone/settings target is company-relative", () => {
    const targets = [
      ...allRailItems().map((i) => i.to),
      ...UI2_PHONE_TABS.map((i) => i.to),
      ...UI2_SETTINGS_SECTIONS.map((s) => s.path),
    ];
    for (const to of targets) {
      expect(to.startsWith("/"), to).toBe(true);
      // No literal company prefix baked into a nav model: first segment
      // must be a lowercase route root, never an upper-case /{P} literal.
      const first = to.replace(/^\//, "").split("/")[0]!;
      expect(first, to).toBe(first.toLowerCase());
    }
  });

  it("the shell builds links only through the prefixing router", () => {
    const rail = readFileSync(join(UI2_SRC, "shell", "Ui2Rail.tsx"), "utf8");
    const phone = readFileSync(join(UI2_SRC, "shell", "Ui2PhoneNav.tsx"), "utf8");
    const palette = readFileSync(join(UI2_SRC, "shell", "Ui2CommanderPalette.tsx"), "utf8");
    const fleet = readFileSync(join(UI2_SRC, "screens", "Ui2FleetSoonScreen.tsx"), "utf8");
    // П1: navigation goes through @/lib/router (Link/useNavigate apply the
    // selectedCompany prefix); no raw react-router-dom navigation and no
    // hand-built /{P}/... literals. selectedCompany in the rail is the
    // footer NAME display only — never a path source.
    for (const [name, src] of [
      ["Ui2Rail", rail],
      ["Ui2PhoneNav", phone],
      ["Ui2CommanderPalette", palette],
      ["Ui2FleetSoonScreen", fleet],
    ] as const) {
      expect(
        src.includes("applyCompanyPrefix"),
        `${name} must not hand-build prefixed paths`,
      ).toBe(false);
      expect(src.includes('from "react-router-dom"'), name).toBe(false);
      expect(src.match(/to=\{?["'`/][A-Z]/), `${name} no literal /{P} targets`).toBeNull();
      expect(src.match(/issuePrefix/), `${name} must not read the prefix directly`).toBeNull();
    }
  });
});

describe("myrmidon(UI-2.0-WAVE-A) П5: one item, one route", () => {
  it("all rail `to` values are unique", () => {
    const tos = allRailItems().map((i) => i.to);
    expect(new Set(tos).size).toBe(tos.length);
  });

  it("all settings section paths are unique", () => {
    const paths = UI2_SETTINGS_SECTIONS.map((s) => s.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("rail `to` values and settings paths never collide (one sanctioned entry point)", () => {
    // The ONE sanctioned shared route is the settings entry: the rail's
    // "Settings" item is the panel's door and the panel's "general"
    // section IS that root screen (ia-v2 §2.3 row 1: Общие → …/settings).
    // Everything else must be disjoint.
    const railTos = new Set(allRailItems().map((i) => i.to));
    for (const section of UI2_SETTINGS_SECTIONS) {
      if (section.key === "general" && section.path === "/company/settings") continue;
      expect(railTos.has(section.path), section.path).toBe(false);
    }
  });

  it("each rail item matches at most one active item per pathname (root equality)", () => {
    const items = allRailItems();
    const roots = items.map(ui2NavRouteRoot);
    // duplicate roots would let two items light up at once
    const realRoots = roots.filter((r) => !r.startsWith("__"));
    expect(new Set(realRoots).size).toBe(realRoots.length);
    // for a synthetic sample of pathnames, at most one item is active
    for (const pathname of ["/OPE/dashboard", "/OPE/agents", "/OPE/fleet", "/OPE/company/settings/system"]) {
      const activeRoot = pathname.split("/").filter(Boolean).slice(1)[0]?.toLowerCase();
      const active = items.filter(
        (item) => ui2NavRouteRoot(item).toLowerCase() === activeRoot,
      );
      expect(active.length, pathname).toBeLessThanOrEqual(1);
    }
  });

  it("the settings 'general' section matches with end (no subpath bleed)", () => {
    const general = UI2_SETTINGS_SECTIONS.find((s) => s.key === "general");
    expect(general?.path).toBe("/company/settings");
    expect(general?.end, "general must use end matching").toBe(true);
  });

  it("the rail renders exactly one aria-current (source-level: only the active link sets it)", () => {
    const rail = readFileSync(join(UI2_SRC, "shell", "Ui2Rail.tsx"), "utf8");
    expect(rail).toMatch(/aria-current=\{active \? "page" : undefined\}/);
  });
});

describe("myrmidon(UI-2.0-WAVE-A) fleet «soon» route", () => {
  it("the fleet entry is routed on its own root", () => {
    const fleet = UI2_ROUTE_TABLE.find((entry) => entry.key === "fleet");
    expect(fleet).toBeDefined();
    expect(fleet?.path).toBe("fleet");
    expect(extractCompanyPrefixFromPath("/fleet")).toBeNull();
  });

  it("the fleet screen renders (its own route + one phrase + System links)", async () => {
    const { Ui2FleetSoonScreen } = await import("../screens/Ui2FleetSoonScreen");
    expect(typeof Ui2FleetSoonScreen).toBe("function");
    const source = readFileSync(join(UI2_SRC, "screens", "Ui2FleetSoonScreen.tsx"), "utf8");
    expect(source).toMatch(/to="\/company\/settings\/system"/);
    expect(source).toMatch(/ui2\.screens\.fleet\.soonTitle/);
  });

  it("the fleet screen route is part of the rendered route set", () => {
    const routes = ui2ScreenRoutes();
    expect(routes.length).toBe(UI2_ROUTE_TABLE.length + 1 + UI2_HIDDEN_SETTINGS_PATHS.length);
    const paths = UI2_ROUTE_TABLE.map((entry) => entry.path);
    expect(paths).toContain("fleet");
    expect(paths).toContain("commander");
  });
});

describe("myrmidon(UI-2.0-WAVE-A) hidden settings sections", () => {
  it("sections without a function are not in the visible panel", () => {
    const visible = new Set(UI2_SETTINGS_SECTIONS.map((s) => s.path));
    for (const hidden of UI2_HIDDEN_SETTINGS_PATHS) {
      expect(visible.has(`/${hidden}`), hidden).toBe(false);
    }
  });

  it("hidden paths render the not-in-wave card via their own route", () => {
    const source = readFileSync(join(UI2_SRC, "routes.tsx"), "utf8");
    expect(source).toMatch(/Ui2NotInWaveScreen/);
    for (const hidden of UI2_HIDDEN_SETTINGS_PATHS) {
      expect(source, hidden).toContain(`"${hidden}"`);
    }
  });

  it("the not-in-wave screen exists and links somewhere working", async () => {
    const { Ui2NotInWaveScreen } = await import("../screens/Ui2NotInWaveScreen");
    expect(typeof Ui2NotInWaveScreen).toBe("function");
  });
});

describe("myrmidon(UI-2.0-WAVE-A) commander root move", () => {
  it("the commander screen lives on /commander and the old path redirects", () => {
    const commander = UI2_ROUTE_TABLE.find((entry) => entry.key === "commander-chat");
    expect(commander?.path).toBe("commander");
    const source = readFileSync(join(UI2_SRC, "routes.tsx"), "utf8");
    expect(source).toContain('path="commander-chat"');
    expect(source).toContain('to="/commander" replace');
  });

  it("the nav, phone tab and palette all point at /commander", () => {
    const commanderRail = allRailItems().find((i) => i.labelKey === "ui2.nav.commander");
    expect(commanderRail?.to).toBe("/commander");
    const commanderTab = UI2_PHONE_TABS.find((i) => i.labelKey === "ui2.nav.commander");
    expect(commanderTab?.to).toBe("/commander");
    const palette = readFileSync(join(UI2_SRC, "shell", "Ui2CommanderPalette.tsx"), "utf8");
    expect(palette).toMatch(/`\/commander\?draft=/);
    expect(palette).not.toMatch(/\/commander-chat/);
  });
});
