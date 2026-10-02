// myrmidon(ABOUT): the "About Myrmidon" section of Instance → General.
// Shows the product lockup, the running release version and build metadata
// from GET /api/myrmidon/about, the required upstream attribution, license
// and project links. Copy lives in the i18n catalogs (en primary, ru
// translation) — see ui/src/i18n/locales.
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "@/i18n";
import { MyrmidonLockup } from "./MyrmidonLockup";
import { aboutApi, aboutQueryKey, type AboutInfo } from "./aboutApi";

function formatBuildDate(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function shortCommit(commit: string | null): string {
  return commit ? commit.slice(0, 7) : "";
}

export function AboutSettingsPanel() {
  const { t } = useTranslation();
  const aboutQuery = useQuery({
    queryKey: aboutQueryKey,
    queryFn: () => aboutApi.get(),
    retry: false,
  });

  const info: AboutInfo | undefined = aboutQuery.data;

  return (
    <section data-testid="myrmidon-about-section">
      <div className="space-y-3">
        <div className="flex items-center gap-3">
          <MyrmidonLockup className="h-6 w-auto" decorative />
          <h2 className="text-sm font-semibold">{t("about.title")}</h2>
        </div>
        {aboutQuery.isError ? (
          <p className="max-w-2xl text-sm text-muted-foreground" data-testid="myrmidon-about-error">
            {t("about.unavailable")}
          </p>
        ) : !info ? (
          <p className="max-w-2xl text-sm text-muted-foreground" data-testid="myrmidon-about-loading">
            {t("about.loading")}
          </p>
        ) : (
          <div className="space-y-1.5 text-sm">
            <p data-testid="myrmidon-about-version">
              <span className="font-medium">{t("about.version")}</span>{" "}
              <span className="font-mono">{info.version}</span>
              {info.buildDate ? (
                <span className="text-muted-foreground"> · {formatBuildDate(info.buildDate)}</span>
              ) : null}
            </p>
            {info.commit ? (
              <p data-testid="myrmidon-about-commit">
                <span className="font-medium">{t("about.commit")}</span>{" "}
                <a
                  href={`${info.links.repo}/commit/${info.commit}`}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono underline underline-offset-2 hover:text-foreground"
                >
                  {shortCommit(info.commit)}
                </a>
              </p>
            ) : null}
            {info.imageDigest ? (
              <p data-testid="myrmidon-about-digest" className="break-all">
                <span className="font-medium">{t("about.imageDigest")}</span>{" "}
                <span className="font-mono">{info.imageDigest}</span>
              </p>
            ) : null}
            <p data-testid="myrmidon-about-base">
              {t("about.base", { version: info.basePaperclipVersion ?? t("about.unknown") })}
            </p>
            <p data-testid="myrmidon-about-license">
              {t("about.license", { license: info.license })} · {t("about.attribution")}
            </p>
            <p className="flex flex-wrap gap-x-4 gap-y-1">
              <a
                href={info.links.repo}
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2 hover:text-foreground"
              >
                {t("about.links.repo")}
              </a>
              <a
                href={info.links.changelog}
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2 hover:text-foreground"
              >
                {t("about.links.changelog")}
              </a>
              <a
                href={info.links.docs}
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2 hover:text-foreground"
              >
                {t("about.links.docs")}
              </a>
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
