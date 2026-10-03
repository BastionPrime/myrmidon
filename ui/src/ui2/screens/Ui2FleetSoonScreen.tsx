// myrmidon(1.7-FLEET-ROUTE): the Server fleet "soon" screen — own route
// /{P}/fleet (Alex 03.10 decision, ia-v2 §2.1.3): the rail item stays
// visible with its own destination while the full fleet surface arrives
// with MONITORING (OPE-3919) and SERVER-ONBOARD (OPE-3420) in 1.7.
//
// The card is one honest phrase plus links to what already lives in
// Settings → System (stack and versions, deploy jobs, maintenance) — the
// temporary home of fleet data. No invented numbers, no skeleton of a
// dashboard that has no data source yet.
import { useTranslation } from "@/i18n";
import { Link } from "@/lib/router";

export function Ui2FleetSoonScreen() {
  const { t } = useTranslation();
  return (
    <section style={{ display: "grid", gap: "var(--myr-space-1)", maxWidth: 640 }}>
      <h1
        className="myr-display"
        style={{ fontSize: "var(--myr-text-hero)", fontWeight: 700, margin: 0, color: "var(--myr-ink)" }}
      >
        {t("ui2.screens.fleet.soonTitle")}
      </h1>
      <p style={{ color: "var(--myr-ink-muted)", fontSize: "var(--myr-text-body)", margin: 0 }}>
        {t("ui2.screens.fleet.soonBody")}
      </p>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "var(--myr-space-1)",
          marginTop: "var(--myr-space-1)",
        }}
      >
        <Link
          to="/company/settings/system"
          style={{
            color: "var(--myr-navy-deep)",
            fontSize: "var(--myr-text-body)",
            fontWeight: 600,
            textDecoration: "none",
          }}
        >
          {t("ui2.screens.fleet.systemLink")}
        </Link>
      </div>
    </section>
  );
}
