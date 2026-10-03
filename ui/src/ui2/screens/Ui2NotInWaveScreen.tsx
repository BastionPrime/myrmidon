// myrmidon(UI-2.0-WAVE-A): the "not in this wave" catch-all for routed
// ui2 paths that have no screen yet. Direct URLs to hidden settings
// sections must NOT fall through to the vendor page or crash (ia-v2 §7
// item 8); they land on this honest card with one link to the nearest
// working screen. This is a distinct component from Ui2PlaceholderScreen
// (the re-skin integration placeholder) on purpose: that one documents
// screens the re-skin pass replaces; this one guards the route space.
import { useTranslation } from "@/i18n";
import { Link } from "@/lib/router";

export function Ui2NotInWaveScreen({ fallbackTo = "/company/settings" }: { fallbackTo?: string }) {
  const { t } = useTranslation();
  return (
    <section style={{ display: "grid", gap: "var(--myr-space-1)", maxWidth: 640 }}>
      <h1
        className="myr-display"
        style={{ fontSize: "var(--myr-text-hero)", fontWeight: 700, margin: 0, color: "var(--myr-ink)" }}
      >
        {t("ui2.screens.notInWave.title")}
      </h1>
      <p style={{ color: "var(--myr-ink-muted)", fontSize: "var(--myr-text-body)", margin: 0 }}>
        {t("ui2.screens.notInWave.body")}
      </p>
      <div style={{ marginTop: "var(--myr-space-1)" }}>
        <Link
          to={fallbackTo}
          style={{
            color: "var(--myr-navy-deep)",
            fontSize: "var(--myr-text-body)",
            fontWeight: 600,
            textDecoration: "none",
          }}
        >
          {t("ui2.screens.notInWave.link")}
        </Link>
      </div>
    </section>
  );
}
