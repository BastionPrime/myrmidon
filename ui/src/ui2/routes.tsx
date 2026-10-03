// myrmidon(UI-0a/UI-0c/UI-2.0-WAVE-A): the screen → ui2/legacy routing
// table. The shell routes are LIVE (the frame renders around every
// existing page); the flagged screens were PLACEHOLDER entries owned by
// the shell part until the re-skin part replaced exactly those
// placeholders with real screens (lead annex: the table is the
// integration contract). A screen moves out of "placeholder" only when
// its ui2 surface reaches parity (screen-map §4.1); until then the vendor
// page keeps serving and the ui2 screen is only reachable under the ui2
// flag.
//
// WAVE-A (OPE-3985): every ROOT of every entry is registered in
// BOARD_ROUTE_ROOTS (ui/src/lib/company-routes.ts) + an App.tsx redirect,
// so `extractCompanyPrefixFromPath('/<root>')` is null for each (П2);
// the commander screen moved to its own `commander` root (ia-v2 §2.2.2)
// and the fleet "soon" screen took the new `fleet` root.
import type { ReactNode } from "react";
import { Navigate, Route } from "@/lib/router";
import { Ui2PlaceholderScreen } from "./screens/Ui2PlaceholderScreen";
import { Ui2I18nProvider } from "./i18n/Ui2I18n";
import { Ui2Decisions } from "./screens/decisions/Ui2Decisions";
import { Ui2Costs } from "./screens/costs/Ui2Costs";
import { Ui2AgentOverviewPage } from "./screens/agent-overview/Ui2AgentOverviewPage";
import { Ui2RunsSettings } from "./screens/settings/runs-queue/Ui2RunsSettings";
import { Ui2SystemSettings } from "./screens/settings/system/Ui2SystemSettings";
import { Ui2LanguageSettings } from "./screens/settings/language/Ui2LanguageSettings";
// myrmidon(1.6-CTO-CHAT-A): the Commander chat screen — a real ui2 screen, not
// a placeholder (see screens/CommanderChatScreen.tsx).
import { CommanderChatScreen } from "./screens/CommanderChatScreen";
// myrmidon(1.7-FLEET-ROUTE): the fleet "soon" screen on its own root.
import { Ui2FleetSoonScreen } from "./screens/Ui2FleetSoonScreen";
// myrmidon(UI-2.0-WAVE-A): the "not in this wave" guard screen.
import { Ui2NotInWaveScreen } from "./screens/Ui2NotInWaveScreen";

export type Ui2ScreenKey =
  | "decisions"
  | "costs"
  | "agent-overview"
  | "settings-runs-queue"
  | "settings-system"
  | "settings-language"
  | "commander-chat"
  | "fleet";

export interface Ui2RouteEntry {
  key: Ui2ScreenKey;
  /** Company-prefixed path the entry owns under the ui2 flag. */
  path: string;
  /** i18n key under ui2.screens */
  titleKey: string;
  /** The current element. Real screens as of the re-skin pass. */
  element: ReactNode;
  /** Which vendor surface this screen re-skins (screen-map §2). */
  legacyPath: string;
}

/**
 * Wrap a screen in the ui2 language provider. The provider is the interim
 * catalog (until the i18n part merges); it is the single seam to swap for
 * the merged module, and the import path contract is pinned by the
 * language-settings guard test.
 */
function ui2Screen(element: ReactNode): ReactNode {
  return <Ui2I18nProvider>{element}</Ui2I18nProvider>;
}

export const UI2_ROUTE_TABLE: Ui2RouteEntry[] = [
  {
    key: "decisions",
    path: "decisions",
    titleKey: "ui2.screens.decisions",
    element: ui2Screen(<Ui2Decisions />),
    legacyPath: "/decisions",
  },
  {
    key: "costs",
    path: "activity/costs",
    titleKey: "ui2.screens.costs",
    element: ui2Screen(<Ui2Costs />),
    legacyPath: "/activity/costs",
  },
  {
    key: "agent-overview",
    path: "agents/:agentId/overview",
    titleKey: "ui2.screens.agentOverview",
    element: ui2Screen(<Ui2AgentOverviewPage />),
    legacyPath: "/agents/:agentId",
  },
  {
    key: "settings-runs-queue",
    path: "company/settings/runs-queue",
    titleKey: "ui2.screens.runsQueue",
    element: ui2Screen(<Ui2RunsSettings />),
    legacyPath: "/company/settings",
  },
  {
    key: "settings-system",
    path: "company/settings/system",
    titleKey: "ui2.screens.system",
    element: ui2Screen(<Ui2SystemSettings />),
    legacyPath: "/company/settings",
  },
  {
    key: "settings-language",
    path: "company/settings/language",
    titleKey: "ui2.screens.language",
    element: ui2Screen(<Ui2LanguageSettings />),
    legacyPath: "/company/settings",
  },
  // myrmidon(1.6-CTO-CHAT-A → WAVE-A): the Commander chat lives on its own
  // `commander` root (ia-v2 §2.2.2). The legacy entry stays /board-chat
  // (conference room); this screen is the single-owner planning
  // conversation, so it does not shadow it. The old /commander-chat path
  // keeps working via the App.tsx redirect.
  {
    key: "commander-chat",
    path: "commander",
    titleKey: "ui2.screens.commanderChat",
    element: <CommanderChatScreen />,
    legacyPath: "/board-chat",
  },
  // myrmidon(1.7-FLEET-ROUTE): the Server fleet "soon" screen — own root
  // with an honest card; the working fleet data lives in Settings →
  // System until MONITORING/SERVER-ONBOARD (ia-v2 §2.1.3, Alex 03.10).
  {
    key: "fleet",
    path: "fleet",
    titleKey: "ui2.screens.fleet.soonTitle",
    element: <Ui2FleetSoonScreen />,
    legacyPath: "/company/settings/system",
  },
];

/**
 * The route ROOT of a ui2 route-table entry — its first path segment
 * (`"agents/:agentId/overview"` → `"agents"`). П2: every distinct root
 * must be a member of BOARD_ROUTE_ROOTS so the company-prefix extractor
 * never mistakes it for a company prefix; the guard test walks this list.
 */
export function ui2RouteEntryRoot(entry: Ui2RouteEntry): string {
  return entry.path.split("/")[0]!;
}

/**
 * The hidden settings sections (no function this wave — ia-v2 §7 item 8).
 * They stay DIRECTLY reachable by URL (the guard renders the
 * "not in this wave" card, no fall-through, no crash) while the settings
 * panel keeps showing only the sections with a working screen.
 */
export const UI2_HIDDEN_SETTINGS_PATHS = [
  "company/settings/guards",
  "company/settings/forage",
  "company/settings/castes",
  "company/settings/channels",
  "company/settings/personal-bot",
] as const;

/**
 * The ui2 screen routes as <Route> elements, to be rendered BEFORE the
 * vendor routes inside the ui2 shell mount so the ui2 entries win (React
 * Router ranks by specificity, and the ui2 paths are distinct
 * except costs which intentionally shadows the vendor route under the flag).
 *
 * WAVE-A additions (OPE-3985):
 *  - a redirect from the old /commander-chat path to /commander (the
 *    Commander screen's own root, ia-v2 §2.2.2) so existing links survive;
 *  - the "not in this wave" guard for hidden settings sections: direct
 *    URLs render the honest card instead of falling through to a vendor
 *    page or crashing (ia-v2 §7 item 8).
 */
export function ui2ScreenRoutes(): ReactNode[] {
  return [
    ...UI2_ROUTE_TABLE.map((entry) => (
      <Route key={entry.key} path={entry.path} element={entry.element} />
    )),
    <Route key="commander-chat-legacy" path="commander-chat" element={<Navigate to="/commander" replace />} />,
    ...UI2_HIDDEN_SETTINGS_PATHS.map((path) => (
      <Route key={`hidden-${path}`} path={path} element={<Ui2NotInWaveScreen />} />
    )),
  ];
}

/**
 * True when the element is still the shell part's placeholder component.
 * The re-skin pass replaces every entry with a real screen wrapped in the
 * ui2 language provider; the guard test uses this identity check to prove
 * no entry is left on the placeholder.
 */
export function isUi2RouteElementAPlaceholder(element: ReactNode): boolean {
  const candidate = element as { type?: unknown } | null;
  if (candidate == null || typeof candidate !== "object") return true;
  return candidate.type === Ui2PlaceholderScreen;
}

/** Kept for the shell's App.tsx call site under the historical name. */
export function ui2PlaceholderRoutes(): ReactNode[] {
  return ui2ScreenRoutes();
}
