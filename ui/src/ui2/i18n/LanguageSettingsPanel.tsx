// myrmidon(UI2-I18N): the Settings → Language screen body (2.0 UI tree).
//
// Screen-map 2.16: language choice (English base, Russian translation) with a
// navigation + decision-card preview, the persistence hint, and the honest
// boundary note (agent-written text and identifiers are never translated;
// missing Russian keys fall back to English). Number/date/timezone format
// pickers arrive with the design tokens session — placeholder copy only, the
// card renders behind the flag until then.
//
// The re-skin pass mounts this panel into the shell's settings navigation;
// it also renders standalone in tests.
import { useQuery } from "@tanstack/react-query";
import { Languages } from "lucide-react";
import { useUi2T } from "./useUi2T";
import { ui2LanguageLabel, useUi2Language, UI2_LANGUAGES, type Ui2Language } from ".";

export function ui2LanguageQueryKey(): Array<string> {
  return ["myrmidon", "ui2", "language"];
}

export function LanguageSettingsPanel() {
  const { t } = useUi2T();
  const { language, setLanguage, saving, saveError } = useUi2Language();
  const preference = useQuery({
    queryKey: ui2LanguageQueryKey(),
    queryFn: () => import("./api").then((m) => m.ui2LanguageApi.get()),
    initialData: { language, updatedAt: null },
  });

  return (
    <section
      className="ui2-language-settings"
      aria-labelledby="ui2-language-settings-title"
      data-testid="ui2-language-settings"
    >
      <header className="ui2-language-settings__header">
        <h2 id="ui2-language-settings-title" className="ui2-language-settings__title">
          {t("language.settingsTitle")}
        </h2>
        <p className="ui2-language-settings__description">{t("language.settingsDescription")}</p>
      </header>

      <fieldset className="ui2-language-settings__choice" role="radiogroup" aria-label={t("language.currentLanguage")}>
        {UI2_LANGUAGES.map((code: Ui2Language) => (
          <label key={code} className="ui2-language-settings__option">
            <input
              type="radio"
              name="ui2-language"
              value={code}
              checked={language === code}
              onChange={() => setLanguage(code)}
              disabled={saving}
              data-testid={`ui2-language-option-${code}`}
            />
            <span className="ui2-language-settings__option-label">{ui2LanguageLabel(code)}</span>
            <Languages
              className="ui2-language-settings__option-icon"
              aria-hidden="true"
              data-selected={language === code}
            />
          </label>
        ))}
      </fieldset>

      <p className="ui2-language-settings__hint" data-testid="ui2-language-server-hint">
        {t("language.serverHint")}
      </p>
      {saveError ? (
        <p className="ui2-language-settings__error" role="alert" data-testid="ui2-language-save-error">
          {t("language.saveFailed")}
        </p>
      ) : null}

      <div className="ui2-language-settings__preview" data-testid="ui2-language-preview">
        <h3 className="ui2-language-settings__preview-title">{t("language.previewTitle")}</h3>
        <div className="ui2-language-settings__preview-nav" aria-label={t("language.previewNav")}>
          <ul className="ui2-language-settings__preview-nav-list">
            <li>{t("language.previewNavItemDecisions")}</li>
            <li>{t("language.previewNavItemSwarm")}</li>
            <li>{t("language.previewNavItemCosts")}</li>
          </ul>
        </div>
        <div
          className="ui2-language-settings__preview-card"
          aria-label={t("language.previewDecisionCard")}
        >
          <p className="ui2-language-settings__preview-card-title">
            {t("language.previewDecisionCardTitle")}
          </p>
          <p className="ui2-language-settings__preview-card-body">
            {t("language.previewDecisionCardBody", { count: 3 })}
          </p>
        </div>
      </div>

      <p className="ui2-language-settings__saved-at" data-testid="ui2-language-saved-at">
        {preference.data?.updatedAt ? t("time.updated", { time: String(preference.data.updatedAt) }) : ""}
      </p>
    </section>
  );
}
