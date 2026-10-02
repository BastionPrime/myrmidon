// myrmidon(UI-0a): the screen → ui2/legacy routing table. The shell routes
// are LIVE (the frame renders around every existing page); the six flagged
// screens are PLACEHOLDER entries owned by this tree until UI-0c replaces
// exactly those placeholders with real screens (lead annex: the table is the
// integration contract — UI-0c swaps the placeholder component per entry,
// nothing else changes). A screen moves out of "placeholder" only when its
// ui2 surface reaches parity (screen-map §4.1); until then the vendor page
// keeps serving and the placeholder is only reachable under the ui2 flag.
import type { ReactNode } from "react";
import { Route } from "@/lib/router";
import { Ui2PlaceholderScreen } from "./screens/Ui2PlaceholderScreen";

export type Ui2ScreenKey =
  | "decisions"
  | "costs"
  | "agent-overview"
  | "settings-runs-queue"
  | "settings-system"
  | "settings-language";

export interface Ui2RouteEntry {
  key: Ui2ScreenKey;
  /** Company-prefixed path the entry owns under the ui2 flag. */
  path: string;
  /** i18n key under ui2.screens */
  titleKey: string;
  /** The current element. Placeholder in UI-0a; UI-0c replaces it. */
  element: ReactNode;
  /** Which vendor surface this screen re-skins (screen-map §2). */
  legacyPath: string;
}

function placeholder(): ReactNode {
  return <Ui2PlaceholderScreen />;
}

export const UI2_ROUTE_TABLE: Ui2RouteEntry[] = [
  {
    key: "decisions",
    path: "decisions",
    titleKey: "ui2.screens.decisions",
    element: placeholder(),
    legacyPath: "/decisions",
  },
  {
    key: "costs",
    path: "activity/costs",
    titleKey: "ui2.screens.costs",
    element: placeholder(),
    legacyPath: "/activity/costs",
  },
  {
    key: "agent-overview",
    path: "agents/:agentId/overview",
    titleKey: "ui2.screens.agentOverview",
    element: placeholder(),
    legacyPath: "/agents/:agentId",
  },
  {
    key: "settings-runs-queue",
    path: "company/settings/runs-queue",
    titleKey: "ui2.screens.runsQueue",
    element: placeholder(),
    legacyPath: "/company/settings",
  },
  {
    key: "settings-system",
    path: "company/settings/system",
    titleKey: "ui2.screens.system",
    element: placeholder(),
    legacyPath: "/company/settings",
  },
  {
    key: "settings-language",
    path: "company/settings/language",
    titleKey: "ui2.screens.language",
    element: placeholder(),
    legacyPath: "/company/settings",
  },
];

/**
 * The placeholder routes as <Route> elements, to be rendered BEFORE the
 * vendor routes inside the ui2 shell mount so the ui2 entries win (React
 * Router ranks by specificity, and the placeholder paths are distinct
 * except costs which intentionally shadows the vendor route under the flag).
 */
export function ui2PlaceholderRoutes(): ReactNode[] {
  return UI2_ROUTE_TABLE.map((entry) => (
    <Route key={entry.key} path={entry.path} element={entry.element} />
  ));
}
