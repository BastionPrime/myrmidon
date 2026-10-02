// ui/src/ui2/index.ts — UI-2.0
//
// myrmidon(UI2): the public surface of the screens tree. The shell part
// owns the tree root and route table; this barrel exposes the re-skin
// screens and their shared helpers for stories and tests.

export { Ui2I18nProvider, useUi2I18n, isUi2Locale, readStoredLocale } from "./i18n/Ui2I18n";
export { UI2_LOCALES, UI2_DEFAULT_LOCALE, formatUi2Message, ui2Messages } from "./i18n/locales";
export type { Ui2Locale, Ui2MessageKey } from "./i18n/locales";
export { LanguageSwitch } from "./i18n/LanguageSwitch";
export { Ui2Decisions } from "./screens/decisions/Ui2Decisions";
export {
  ui2DecisionGroup,
  ui2DecisionAge,
  ui2GroupCounts,
  ui2OptionEffectSummary,
  ui2SortOptions,
} from "./screens/decisions/ui2DecisionsModel";
export type { Ui2DecisionGroup } from "./screens/decisions/ui2DecisionsModel";
export { Ui2Costs } from "./screens/costs/Ui2Costs";
export { Ui2AgentOverview } from "./screens/agent-overview/Ui2AgentOverview";
export { Ui2AgentOverviewPage } from "./screens/agent-overview/Ui2AgentOverviewPage";
export { Ui2RunsSettings } from "./screens/settings/runs-queue/Ui2RunsSettings";
export { Ui2SystemSettings } from "./screens/settings/system/Ui2SystemSettings";
export { Ui2LanguageSettings } from "./screens/settings/language/Ui2LanguageSettings";
