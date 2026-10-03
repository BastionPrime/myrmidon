// ui/src/ui2/screens/settings/language/Ui2LanguageSettings.tsx
//
// myrmidon(UI2): Settings → "Language" in the new shell. The switch itself
// comes from the shared language-switch module at the agreed import path
// `ui2/i18n/LanguageSwitch` (local implementation until that part merges —
// reviewer checkpoint: keep this import path stable). The preview card is
// built from a mock-shaped decision so the operator sees RU/EN side by side
// before committing. Number/date formats and timezone belong to the later formats slice
// and stay out of this screen.

import { LanguageSwitch } from "../../../i18n/LanguageSwitch";
import { useUi2I18n } from "../../../i18n/Ui2I18n";
import { Ui2Page, Ui2Section } from "../../../components/ui2Primitives";

export function Ui2LanguageSettings() {
  const { t } = useUi2I18n();

  return (
    <Ui2Page title={t("ui2.settings.language.title")} subtitle={t("ui2.settings.language.subtitle")}>
      <Ui2Section title={t("ui2.settings.language.title")}>
        <LanguageSwitch />
        <p className="ui2-language-hint text-xs text-muted-foreground">
          {t("ui2.settings.language.note")}
        </p>
      </Ui2Section>

      <Ui2Section title={t("ui2.settings.language.preview.title")}>
        <div className="ui2-language-preview rounded-md border border-border p-3">
          <p className="ui2-language-preview-title text-sm font-medium">
            {t("ui2.settings.language.preview.decisionTitle")}
          </p>
          <p className="ui2-language-preview-body mt-1 text-sm text-muted-foreground">
            {t("ui2.settings.language.preview.decisionBody")}
          </p>
          <div className="ui2-language-preview-meta mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>{t("ui2.decisions.card.preparedBy", { agent: "agent-a" })}</span>
            <span>{t("ui2.decisions.card.age", { age: "2h" })}</span>
          </div>
        </div>
      </Ui2Section>
    </Ui2Page>
  );
}
