// myrmidon(UI-0a): the settings side panel — a 10-section skeleton keyed to
// the screen-map §3.1 spec ("Settings: internal side panel of 10 sections").
// Sections land as real screens with their waves (UI-0c re-skins the ones
// that already have data; the rest stay skeleton rows). Rendered inside the
// ui2 shell for any /company/settings/* route under the flag.
import { NavLink } from "@/lib/router";
import { useTranslation } from "@/i18n";

export const UI2_SETTINGS_SECTIONS = [
  { key: "general", path: "/company/settings" },
  { key: "members", path: "/company/settings/members" },
  { key: "access", path: "/company/settings/access-hub" },
  { key: "secrets", path: "/company/settings/secrets" },
  { key: "runs", path: "/company/settings/runs-queue" },
  { key: "budgets", path: "/company/settings/budgets" },
  { key: "autonomy", path: "/company/settings/autonomy" },
  { key: "guards", path: "/company/settings/guards" },
  { key: "castes", path: "/company/settings/castes" },
  { key: "system", path: "/company/settings/system" },
] as const;

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
