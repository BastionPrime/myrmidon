// myrmidon(UI-0a/UI-2.0-WAVE-A): the settings side panel, keyed to the
// owner-approved settings tree (ia-v2 §2.3/§2.5). Wave-A routing rules:
//   - a section appears in the panel ONLY when it has a working screen
//     (ia-v2 §7 item 8); sections without a function this wave
//     (Guardrails, Forage, Castes, Channels, Personal bot) stay hidden —
//     their direct URLs render the "not in this wave" card (routes.tsx);
//   - every section owns exactly one unique path and `general` matches
//     with `end` so exactly one section is active at a time (П5, the
//     03.10 all-subpaths-highlighted defect).
import { NavLink } from "@/lib/router";
import { useTranslation } from "@/i18n";

export interface Ui2SettingsSection {
  key: string;
  /** Company-relative path (the shell's NavLink applies the prefix, П1). */
  path: string;
  /**
   * True when the section's path must match exactly (the "general"
   * overview at the settings root must NOT highlight on subpaths).
   */
  end?: boolean;
}

/**
 * The visible settings sections (ia-v2 §2.5): only the ones with a
 * working screen this wave. Adding a section here requires a working
 * screen and a unique path — the guard test pins uniqueness.
 */
export const UI2_SETTINGS_SECTIONS: Ui2SettingsSection[] = [
  { key: "general", path: "/company/settings", end: true },
  { key: "members", path: "/company/settings/members" },
  { key: "access", path: "/company/settings/access" },
  { key: "secrets", path: "/company/settings/secrets" },
  { key: "autonomy", path: "/company/settings/autonomy" },
  { key: "runs", path: "/company/settings/runs-queue" },
  { key: "system", path: "/company/settings/system" },
  { key: "language", path: "/company/settings/language" },
];

export function Ui2SettingsSidebar() {
  const { t } = useTranslation();
  return (
    <nav
      className="myr-ui2__settings-nav"
      aria-label={t("ui2.settings.navLabel")}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 2,
        width: "var(--myr-rail-width)",
        flex: "0 0 var(--myr-rail-width)",
        background: "var(--myr-surface-raised)",
        borderRight: "1px solid var(--myr-hairline)",
        padding: "var(--myr-space-1)",
      }}
    >
      {UI2_SETTINGS_SECTIONS.map((section) => (
        <NavLink
          key={section.key}
          to={section.path}
          end={section.end}
          style={({ isActive }) => ({
            display: "flex",
            alignItems: "center",
            height: "var(--myr-rail-item-h)",
            padding: "0 10px",
            borderRadius: "var(--myr-radius-sm)",
            background: isActive ? "var(--myr-navy-deep)" : "transparent",
            color: isActive ? "var(--myr-on-navy)" : "var(--myr-ink-muted)",
            fontSize: "var(--myr-text-body)",
            fontWeight: isActive ? 600 : 500,
            textDecoration: "none",
          })}
        >
          {t(`ui2.settings.${section.key}`)}
        </NavLink>
      ))}
    </nav>
  );
}
