// myrmidon(UI-0a): UI-2.0 top bar — nest switcher ("All nests" = project
// scope today, screen-map §5 q1), status chips (colony / fleet / forecast),
// the "Tell the Commander" entry (opens the commander palette stub) and the
// decisions badge. Until STATUS-STRIP exists the chips read the composed
// strip (useUi2Status). Every visual value comes from --myr-* tokens.
import { useState } from "react";
import { CircleAlert, ChevronDown, MessagesSquare, Server, Users, Wallet } from "lucide-react";
import { useTranslation } from "@/i18n";
import { useCompany } from "@/context/CompanyContext";
import { cn } from "@/lib/utils";
import { useUi2StatusStrip } from "../useUi2Status";
import { Ui2CommanderPalette } from "./Ui2CommanderPalette";

function formatMoney(cents: number): string {
  return `$${Math.round(cents / 100).toLocaleString("en-US")}`;
}

function StatusChip({
  icon: Icon,
  label,
  tone,
  mono,
}: {
  icon: typeof Users;
  label: string;
  tone: "default" | "attention";
  mono?: boolean;
}) {
  return (
    <span
      className="myr-ui2__chip"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        borderRadius: "var(--myr-radius-sm)",
        border: "1px solid var(--myr-hairline)",
        background: tone === "attention" ? "var(--myr-signal-warn-t)" : "var(--myr-surface-sunk)",
        color: tone === "attention" ? "var(--myr-signal-warn)" : "var(--myr-ink-muted)",
        padding: "4px 8px",
        fontSize: "var(--myr-text-nano)",
        fontWeight: 500,
        lineHeight: 1.2,
        whiteSpace: "nowrap",
      }}
    >
      <Icon aria-hidden="true" style={{ width: 12, height: 12 }} />
      <span
        style={{
          fontFamily: mono ? "var(--myr-font-mono)" : undefined,
          fontSize: mono ? "var(--myr-text-nano)" : undefined,
        }}
      >
        {label}
      </span>
    </span>
  );
}

export function Ui2TopBar() {
  const { t } = useTranslation();
  const { selectedCompanyId } = useCompany();
  const strip = useUi2StatusStrip(selectedCompanyId);
  const [paletteOpen, setPaletteOpen] = useState(false);

  return (
    <header
      className="myr-ui2__topbar"
      style={{
        height: "var(--myr-topbar-height)",
        display: "flex",
        alignItems: "center",
        gap: "var(--myr-space-2)",
        padding: "0 var(--myr-space-2)",
        background: "var(--myr-surface-raised)",
        borderBottom: "1px solid var(--myr-hairline)",
      }}
    >
      {/* Nest switcher. Nests are projects before 2.0 (owner 02.10); the
          switcher is a stub that states the scope rather than a menu until
          the multi-project selector lands. */}
      <button
        type="button"
        className="myr-ui2__nest-switcher"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          borderRadius: "var(--myr-radius-sm)",
          border: "1px solid var(--myr-hairline)",
          background: "transparent",
          color: "var(--myr-ink)",
          padding: "6px 10px",
          fontSize: "var(--myr-text-body)",
          fontWeight: 600,
        }}
      >
        {t("ui2.nests.all", { defaultValue: "All nests" })}
        <ChevronDown aria-hidden="true" style={{ width: 14, height: 14, color: "var(--myr-ink-muted)" }} />
      </button>

      <div
        className="myr-ui2__status-strip"
        style={{ display: "flex", alignItems: "center", gap: 8, overflow: "hidden" }}
      >
        {strip ? (
          <>
            <StatusChip
              icon={Users}
              label={t("ui2.chip.colony", {
                defaultValue: "{{active}} of {{total}}",
                active: strip.colonyActive,
                total: strip.colonyTotal,
              })}
              tone="default"
            />
            <StatusChip
              icon={Server}
              label={strip.fleetAttention ? t("ui2.chip.fleetAttention", { defaultValue: "Fleet: 1 attention" }) : t("ui2.chip.fleet", { defaultValue: "Fleet" })}
              tone={strip.fleetAttention ? "attention" : "default"}
            />
            <StatusChip
              icon={Wallet}
              // myrmidon(HERMES-USAGE-COST): no budget set — show spend only.
              // "{{spend}} of {{budget}}" with budget $0 reads as the lying
              // "$0 of $0" plaque; the spend-only variant keeps the chip
              // truthful when no cap is configured.
              label={
                strip.monthBudgetCents > 0
                  ? t("ui2.chip.forecast", {
                      defaultValue: "{{spend}} of {{budget}}",
                      spend: formatMoney(strip.monthSpendCents),
                      budget: formatMoney(strip.monthBudgetCents),
                    })
                  : t("ui2.chip.forecastSpendOnly", {
                      defaultValue: "{{spend}} spent",
                      spend: formatMoney(strip.monthSpendCents),
                    })
              }
              tone="default"
              mono
            />
          </>
        ) : null}
      </div>

      <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "var(--myr-space-1)" }}>
        {/* Commander entry: stub — opens the palette; the palette's action
            routes to the existing chat surface (screen-map §2.3: CTO-CHAT
            lands with 1.6; UI-0 only wires the entry point). */}
        <button
          type="button"
          className="myr-ui2__commander-entry"
          aria-label={t("ui2.commander.aria", { defaultValue: "Tell the Commander (Ctrl K)" })}
          onClick={() => setPaletteOpen(true)}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            height: 36,
            minWidth: 240,
            borderRadius: "var(--myr-radius-md)",
            border: "1px solid var(--myr-hairline)",
            background: "var(--myr-surface-sunk)",
            color: "var(--myr-ink-muted)",
            padding: "0 12px",
            fontSize: "var(--myr-text-body)",
            textAlign: "left",
          }}
        >
          <MessagesSquare aria-hidden="true" style={{ width: 14, height: 14, flex: "0 0 auto" }} />
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {t("ui2.commander.placeholder", { defaultValue: "Tell the Commander…" })}
          </span>
          <kbd
            style={{
              marginLeft: "auto",
              fontFamily: "var(--myr-font-mono)",
              fontSize: "var(--myr-text-nano)",
              color: "var(--myr-ink-muted)",
              border: "1px solid var(--myr-hairline)",
              borderRadius: "var(--myr-radius-sm)",
              padding: "1px 6px",
            }}
          >
            Ctrl K
          </kbd>
        </button>
        {strip && strip.attentionCount > 0 ? (
          <span
            aria-label={t("ui2.decisions.badge", { defaultValue: "{{count}} decisions waiting", count: strip.attentionCount })}
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 6,
              background: "var(--myr-inverse-surface)",
              color: "var(--myr-on-navy)",
              borderRadius: "var(--myr-radius-md)",
              padding: "6px 10px",
              fontSize: "var(--myr-text-nano)",
              fontWeight: 700,
            }}
          >
            <CircleAlert aria-hidden="true" style={{ width: 12, height: 12 }} />
            {strip.attentionCount > 99 ? "99+" : strip.attentionCount}
          </span>
        ) : null}
      </div>

      {paletteOpen ? <Ui2CommanderPalette onClose={() => setPaletteOpen(false)} /> : null}
    </header>
  );
}