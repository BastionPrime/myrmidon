// ui/src/ui2/tests/ui2Screens.myrmidom.test.ts — UI-2.0
//
// myrmidon(UI2): the route-table guard for the re-skin integration. The
// shell part owns UI2_ROUTE_TABLE (the integration contract: the six
// flagged screens as entries); this pass replaced the placeholder element
// of every entry with a real screen. The guard pins exactly that: each of
// the six entries carries a NON-placeholder element, the paths stay the
// contract paths (the vendor routes keep their own shapes), and the legacy
// paths stay stable so parity comparison stays possible.

import { describe, expect, it } from "vitest";
import { UI2_ROUTE_TABLE } from "../routes";
import { isUi2RouteElementAPlaceholder } from "../routes";

describe("myrmidon(UI2) route table integration", () => {
  // myrmidon(UI-2.0-WAVE-A): the fleet "soon" screen joined the table.
  it("ships the contract entries plus the commander chat and fleet soon screens", () => {
    expect(UI2_ROUTE_TABLE.map((entry) => entry.key).sort()).toEqual([
      "agent-overview",
      "commander-chat",
      "costs",
      "decisions",
      "fleet",
      "settings-language",
      "settings-runs-queue",
      "settings-system",
    ]);
  });

  it("every entry renders a real screen, not the placeholder", () => {
    for (const entry of UI2_ROUTE_TABLE) {
      expect(isUi2RouteElementAPlaceholder(entry.element), entry.key).toBe(false);
    }
  });

  it("keeps the contract paths and legacy paths stable", () => {
    const byKey = new Map(UI2_ROUTE_TABLE.map((entry) => [entry.key, entry]));
    expect(byKey.get("decisions")?.path).toBe("decisions");
    expect(byKey.get("costs")?.path).toBe("activity/costs");
    expect(byKey.get("agent-overview")?.path).toBe("agents/:agentId/overview");
    expect(byKey.get("settings-runs-queue")?.path).toBe("company/settings/runs-queue");
    expect(byKey.get("settings-system")?.path).toBe("company/settings/system");
    expect(byKey.get("settings-language")?.path).toBe("company/settings/language");
    // myrmidon(UI-2.0-WAVE-A): commander moved to its own root; the fleet
    // "soon" screen rides its own root too.
    expect(byKey.get("commander-chat")?.path).toBe("commander");
    expect(byKey.get("fleet")?.path).toBe("fleet");
    expect(byKey.get("decisions")?.legacyPath).toBe("/decisions");
    expect(byKey.get("costs")?.legacyPath).toBe("/activity/costs");
    expect(byKey.get("agent-overview")?.legacyPath).toBe("/agents/:agentId");
  });
});
