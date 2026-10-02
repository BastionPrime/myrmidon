// myrmidon(UI-0a): UI-2.0 left rail — 232px, logo, three groups, owner
// footer with the active channel. Token-only styles (DESIGN.md: every value
// comes from the token layer; this tree uses the --myr-* set in
// ui/src/ui2/tokens.css via inline var() references — vendor tailwind
// utilities that carry values are avoided on purpose so check-token-gates
// never depends on an allowlist for ui2).
import { useTranslation } from "@/i18n";
import { useCompany } from "@/context/CompanyContext";
import { Link, useLocation } from "@/lib/router";
import { MyrmidonLockup } from "@/components/myrmidon/MyrmidonLockup"; // myrmidon(B1a)
import { UI2_NAV_GROUPS, type Ui2NavItem } from "../navModel";
import { useUi2AttentionCount } from "../useUi2Status";

function RailItem({ item, active, badge }: { item: Ui2NavItem; active: boolean; badge?: number }) {
  const { t } = useTranslation();
  const Icon = item.icon;
  return (
    <span
      className="myr-ui2__rail-item"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        height: "var(--myr-rail-item-h)",
        padding: "0 10px",
        borderRadius: "var(--myr-radius-sm)",
        background: active ? "var(--myr-navy-deep)" : "transparent",
        color: active ? "var(--myr-on-navy)" : "var(--myr-ink-muted)",
        transition: "background 120ms ease, color 120ms ease",
      }}
    >
      <Icon aria-hidden="true" style={{ width: 16, height: 16, flex: "0 0 auto" }} />
      <span
        style={{
          fontSize: "var(--myr-text-body)",
          fontWeight: active ? 600 : 500,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {t(item.labelKey)}
      </span>
      {badge != null && badge > 0 ? (
        <span
          style={{
            marginLeft: "auto",
            background: "var(--myr-inverse-surface)",
            color: "var(--myr-on-navy)",
            borderRadius: "var(--myr-radius-sm)",
            fontSize: "var(--myr-text-nano)",
            fontWeight: 700,
            lineHeight: 1,
            padding: "3px 6px",
          }}
          aria-label={t("ui2.nav.badge.attention", { count: badge })}
        >
          {badge > 99 ? "99+" : badge}
        </span>
      ) : null}
    </span>
  );
}

function RailItemSlot({ item, attentionCount }: { item: Ui2NavItem; attentionCount: number | null }) {
  const location = useLocation();
  const segment = item.to.replace(/^\//, "").split("/")[0];
  const active = location.pathname
    .split("/")
    .filter(Boolean)
    .slice(1)
    .some((p) => p === segment);
  const badge = item.badge === "attention" ? (attentionCount ?? undefined) : undefined;
  return (
    <Link
      to={item.to}
      className="myr-ui2__rail-link"
      style={{ display: "block", textDecoration: "none" }}
    >
      <RailItem item={item} active={active} badge={badge} />
    </Link>
  );
}

export function Ui2Rail() {
  const { t } = useTranslation();
  const { selectedCompany } = useCompany();
  const attentionCount = useUi2AttentionCount();

  return (
    <aside
      className="myr-ui2__rail hidden md:flex md:flex-col"
      style={{
        width: "var(--myr-rail-width)",
        flex: "0 0 var(--myr-rail-width)",
        background: "var(--myr-surface-raised)",
        borderRight: "1px solid var(--myr-hairline)",
      }}
      aria-label={t("ui2.nav.railLabel")}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          height: "var(--myr-topbar-height)",
          padding: "0 var(--myr-space-2)",
          gap: "var(--myr-space-1)",
        }}
      >
        <MyrmidonLockup className="max-h-7 w-auto" decorative />
      </div>

      <nav
        style={{
          padding: "0 var(--myr-space-1)",
          display: "flex",
          flexDirection: "column",
          gap: "var(--myr-space-2)",
          overflowY: "auto",
        }}
      >
        {UI2_NAV_GROUPS.map((group) => (
          <div key={group.labelKey} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {group.labelKey ? (
              <div
                className="myr-ui2__rail-group-label"
                style={{
                  fontSize: "var(--myr-text-nano)",
                  fontWeight: 700,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  color: "var(--myr-ink-muted)",
                  padding: "6px var(--myr-space-1) 6px 10px",
                }}
              >
                {t(group.labelKey)}
              </div>
            ) : null}
            {group.items.map((item) => (
              <RailItemSlot key={item.labelKey} item={item} attentionCount={attentionCount} />
            ))}
          </div>
        ))}
      </nav>

      <div
        style={{
          marginTop: "auto",
          borderTop: "1px solid var(--myr-hairline)",
          padding: "var(--myr-space-1) var(--myr-space-2)",
          display: "flex",
          flexDirection: "column",
          gap: 2,
        }}
      >
        <span
          style={{
            fontSize: "var(--myr-text-nano)",
            color: "var(--myr-ink)",
            fontWeight: 600,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {selectedCompany?.name ?? t("ui2.owner")}
        </span>
        <span style={{ fontSize: "var(--myr-text-nano)", color: "var(--myr-ink-muted)" }}>
          {t("ui2.ownerChannel")}
        </span>
      </div>
    </aside>
  );
}
