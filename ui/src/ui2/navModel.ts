// myrmidon(UI-2.0-WAVE-A): navigation model of the UI-2.0 shell — the left
// rail, the phone bottom bar and the rail's "Wait for me" badge source.
// Shape follows the owner-approved tree of the IA stage 1 document
// (OPE-3923 `ia-v2` §2.5, decisions 03.10):
//
//   НАБЛЮДЕНИЕ   Командный центр /{P}/dashboard, Рой /{P}/agents,
//                Флот серверов /{P}/fleet («скоро», 1.7),
//                Расходы /{P}/costs, Качество /{P}/quality
//   РЕШЕНИЯ И СВЯЗЬ   Ждёт меня /{P}/decisions, Полководец /{P}/commander
//   РАБОТА       Задачи /{P}/issues, Проекты /{P}/projects
//   УПРАВЛЕНИЕ   Настройки /{P}/company/settings
//
// Wave-A routing rules (ia-v2 §2.0 П1/П5):
//   - every `to` is a company-relative path ("/dashboard", "/fleet", …);
//     the shell's Link applies the selectedCompany prefix — links are
//     NEVER built from an already-prefixed path;
//   - every rail item owns exactly ONE unique route (no two items on one
//     screen — the 03.10 double-highlight defect), guarded by test;
//   - activity is matched by route ROOT, not by the first path segment of
//     a shared destination.
// i18n: labels come from the `ui2.nav.*` keys (en/ru) — no literals in
// this tree (screen-map §3.4).
import {
  Activity,
  CircleAlert,
  Gauge,
  LayoutGrid,
  MessagesSquare,
  Server,
  Users,
  Wallet,
} from "lucide-react";

export interface Ui2NavItem {
  /** i18n key under ui2.nav */
  labelKey: string;
  /**
   * Company-relative destination path (unprefixed). The shell's Link
   * resolves it against selectedCompany.issuePrefix (П1: never a
   * hand-built /{P}/... literal).
   */
  to: string;
  icon: typeof Gauge;
  /** Badge count source key; the shell fills counts from live queries. */
  badge?: "attention";
  /**
   * Route root used for the active-item match (П5). Defaults to the first
   * segment of `to`; set explicitly when `to` itself is ambiguous.
   */
  root?: string;
}

export interface Ui2NavGroup {
  labelKey: string | null;
  items: Ui2NavItem[];
}

/** Route root of a company-relative path ("/agents/all" → "agents"). */
export function ui2NavRouteRoot(item: Ui2NavItem): string {
  return item.root ?? item.to.replace(/^\//, "").split("/")[0]!;
}

/** Desktop rail groups: Observe / Decide & talk / Work / Manage (ia-v2 §2.5). */
export const UI2_NAV_GROUPS: Ui2NavGroup[] = [
  {
    labelKey: "ui2.nav.group.observe",
    items: [
      { labelKey: "ui2.nav.center", to: "/dashboard", icon: Gauge },
      { labelKey: "ui2.nav.swarm", to: "/agents", icon: Users },
      // myrmidon(1.7-FLEET-ROUTE): own route + "soon" screen (Alex 03.10);
      // the temporary home of fleet data is System settings (ia-v2 §2.1.3).
      { labelKey: "ui2.nav.fleet", to: "/fleet", icon: Server },
      { labelKey: "ui2.nav.costs", to: "/activity/costs", icon: Wallet },
      { labelKey: "ui2.nav.quality", to: "/quality", icon: Activity },
    ],
  },
  {
    labelKey: "ui2.nav.group.decide",
    items: [
      { labelKey: "ui2.nav.waiting", to: "/decisions", icon: CircleAlert, badge: "attention" },
      // myrmidon(1.6-CTO-CHAT-A → WAVE-A): the commander screen now lives on
      // its own /commander root (ia-v2 §2.2.2); the old /commander-chat path
      // redirects so existing links keep working.
      { labelKey: "ui2.nav.commander", to: "/commander", icon: MessagesSquare },
    ],
  },
  {
    // myrmidon(UI-2.0-WAVE-A): the Work group (Задачи/Проекты) is an
    // owner-approved canvas deviation (Alex 03.10) — the daily board work
    // stays reachable from the new shell.
    labelKey: "ui2.nav.group.work",
    items: [
      { labelKey: "ui2.nav.issues", to: "/issues", icon: LayoutGrid },
      { labelKey: "ui2.nav.projects", to: "/projects", icon: LayoutGrid },
    ],
  },
  {
    labelKey: "ui2.nav.group.manage",
    items: [{ labelKey: "ui2.nav.settings", to: "/company/settings", icon: LayoutGrid }],
  },
];

/** Phone bottom bar: 5 tabs (Center / Waiting / Swarm / Commander / More). */
export const UI2_PHONE_TABS: Ui2NavItem[] = [
  { labelKey: "ui2.nav.center", to: "/dashboard", icon: Gauge },
  { labelKey: "ui2.nav.waiting", to: "/decisions", icon: CircleAlert, badge: "attention" },
  { labelKey: "ui2.nav.swarm", to: "/agents", icon: Users },
  { labelKey: "ui2.nav.commander", to: "/commander", icon: MessagesSquare },
  { labelKey: "ui2.nav.more", to: "/agents", icon: LayoutGrid, root: "__more__" },
];
