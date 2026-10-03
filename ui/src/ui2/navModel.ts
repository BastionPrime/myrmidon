// myrmidon(UI-0a): navigation model of the UI-2.0 shell — the left rail, the
// phone bottom bar and the rail's "Wait for me" badge source. Shape follows
// the Nav piece of the design canvas (source of truth: the navigation ON THE
// BOARDS — Main/Waiting/etc, not the standalone Nav fragment which disagrees;
// see OPE-3546 screen-map §2.17).
//
// Destination routes point at the EXISTING vendor pages for now (the shell
// runs in parallel with 1.5 — OPE-3550); each ui2 screen replaces its route
// only when it reaches parity (screen-map §4.1). i18n: labels come from the
// `ui2.nav.*` keys (en/ru) — no literals in this tree (screen-map §3.4).
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
  /** Destination path (company-prefixed by the shell's Link) */
  to: string;
  icon: typeof Gauge;
  /** Badge count source key; the shell fills counts from live queries. */
  badge?: "attention";
}

export interface Ui2NavGroup {
  labelKey: string | null;
  items: Ui2NavItem[];
}

/** Desktop rail groups: Observe / Decide & talk / Manage (Nav piece). */
export const UI2_NAV_GROUPS: Ui2NavGroup[] = [
  {
    labelKey: "ui2.nav.group.observe",
    items: [
      { labelKey: "ui2.nav.center", to: "/dashboard", icon: Gauge },
      { labelKey: "ui2.nav.fleet", to: "/agents/all", icon: Server },
      { labelKey: "ui2.nav.swarm", to: "/agents/all", icon: Users },
      { labelKey: "ui2.nav.costs", to: "/activity/costs", icon: Wallet },
      { labelKey: "ui2.nav.quality", to: "/dashboard", icon: Activity },
    ],
  },
  {
    labelKey: "ui2.nav.group.decide",
    items: [
      { labelKey: "ui2.nav.waiting", to: "/decisions", icon: CircleAlert, badge: "attention" },
      // myrmidon(1.6-CTO-CHAT-A): Commander now opens the real Commander chat
      // (planning conversation) instead of the legacy conference-room board chat.
      { labelKey: "ui2.nav.commander", to: "/commander-chat", icon: MessagesSquare },
    ],
  },
  {
    labelKey: "ui2.nav.group.manage",
    items: [{ labelKey: "ui2.nav.settings", to: "/company/settings", icon: LayoutGrid }],
  },
];

/** Phone bottom bar: 5 tabs (Center / Decisions / Fleet / Commander / More). */
export const UI2_PHONE_TABS: Ui2NavItem[] = [
  { labelKey: "ui2.nav.center", to: "/dashboard", icon: Gauge },
  { labelKey: "ui2.nav.waiting", to: "/decisions", icon: CircleAlert, badge: "attention" },
  { labelKey: "ui2.nav.fleet", to: "/agents/all", icon: Server },
  // myrmidon(1.6-CTO-CHAT-A): same switch on the phone tab bar.
  { labelKey: "ui2.nav.commander", to: "/commander-chat", icon: MessagesSquare },
  { labelKey: "ui2.nav.more", to: "/agents/all", icon: LayoutGrid },
];
