// myrmidon(UI-0a): the placeholder screen for the six routed ui2 entries.
// UI-0c replaces exactly these components (lead annex); the placeholder is
// honest about its state (design decision 02.10: empty/denied states are
// first-class) and carries the state-artboard shapes — skeleton loading and
// an explicit "not in this wave" body, never invented numbers.
// Strings live in this one module's keys (ui2.screens.*) so UI-0b's sweep
// and UI-0c's replacement each touch one place.
import { useTranslation } from "@/i18n";
import { Link } from "@/lib/router";

export function Ui2PlaceholderScreen() {
  const { t } = useTranslation();
  return (
    <section style={{ display: "grid", gap: "var(--myr-space-1)", maxWidth: 640 }}>
      <h1
        className="myr-display"
        style={{ fontSize: "var(--myr-text-hero)", fontWeight: 700, margin: 0, color: "var(--myr-ink)" }}
      >
        {t("ui2.screens.placeholderTitle")}
      </h1>
      <p style={{ color: "var(--myr-ink-muted)", fontSize: "var(--myr-text-body)", margin: 0 }}>
        {t("ui2.screens.placeholderBody")}
      </p>
      {/* Skeleton row: the loading-state shape from the state artboards so
          the placeholder already demonstrates the state language UI-0c
          builds on. */}
      <div
        aria-hidden="true"
        style={{
          display: "grid",
          gap: "var(--myr-space-1)",
          background: "var(--myr-surface-raised)",
          border: "1px solid var(--myr-hairline)",
          borderRadius: "var(--myr-radius-md)",
          padding: "var(--myr-space-2)",
        }}
      >
        {[0, 1, 2].map((row) => (
          <div
            key={row}
            style={{
              height: 12,
              borderRadius: "var(--myr-radius-sm)",
              background: "var(--myr-surface-sunk)",
              width: row === 2 ? "60%" : "100%",
            }}
          />
        ))}
      </div>
      <Link
        to="/decisions"
        style={{
          color: "var(--myr-navy-deep)",
          fontSize: "var(--myr-text-body)",
          fontWeight: 600,
          textDecoration: "none",
        }}
      >
        {t("ui2.screens.placeholderLegacyLink")}
      </Link>
    </section>
  );
}
