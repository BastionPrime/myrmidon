// myrmidon(UI-0a/UI-0c): the screen → ui2/legacy routing table. The shell
// routes are LIVE (the frame renders around every existing page); the six
// flagged screens were PLACEHOLDER entries owned by the shell part until the
// re-skin part replaced exactly those placeholders with real screens (lead
// annex: the table is the integration contract — this pass swaps the
// placeholder component per entry, nothing else changes). A screen moves out
// of "placeholder" only when its ui2 surface reaches parity (screen-map
// §4.1); until then the vendor page keeps serving and the ui2 screen is only
// reachable under the ui2 flag.
import type { ReactNode } from "react";
import { Route } from "@/lib/router";
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

export type Ui2ScreenKey =
  | "decisions"
  | "costs"
  | "agent-overview"
  | "settings-runs-queue"
  | "settings-system"
  | "settings-language"
  | "commander-chat";

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
  // myrmidon(1.6-CTO-CHAT-A): the Commander chat — own route under the ui2
  // flag. The legacy entry stays /board-chat (conference room); this screen is
  // the single-owner planning conversation, so it does not shadow it.
  {
    key: "commander-chat",
    path: "commander-chat",
    titleKey: "ui2.screens.commanderChat",
    element: <CommanderChatScreen />,
    legacyPath: "/board-chat",
  },
];

/**
 * The ui2 screen routes as <Route> elements, to be rendered BEFORE the
 * vendor routes inside the ui2 shell mount so the ui2 entries win (React
 * Router ranks by specificity, and the ui2 paths are distinct
 * except costs which intentionally shadows the vendor route under the flag).
 */
export function ui2ScreenRoutes(): ReactNode[] {
  return UI2_ROUTE_TABLE.map((entry) => (
    <Route key={entry.key} path={entry.path} element={entry.element} />
  ));
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
