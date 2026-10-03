import i18n, { type InitOptions, type TOptions } from "i18next";
import { initReactI18next, useTranslation as useReactI18nextTranslation } from "react-i18next";

import { DEFAULT_LOCALE, i18nextResources, supportedLocales } from "./locales";
// myrmidon(UI-RU): fork localization engine — merges the fork catalog over the
// vendor locales and applies the persisted language choice before init, so a
// reload keeps the selected language instead of resetting to English.
import { forkI18nResources, initialForkLanguage } from "./myrmidon-i18n";

const i18nextOptions: InitOptions = {
  resources: forkI18nResources(i18nextResources),
  lng: initialForkLanguage(),
  fallbackLng: DEFAULT_LOCALE,
  supportedLngs: supportedLocales,
  defaultNS: "translation",
  interpolation: { escapeValue: false },
  returnObjects: false,
  initAsync: false,
};

void i18n.use(initReactI18next).init(i18nextOptions).catch((error: unknown) => {
  console.error("Failed to initialize i18next", error);
});

if (typeof document !== "undefined") {
  document.documentElement.lang = initialForkLanguage();
}


export function t(key: string, options: TOptions = {}) {
  return i18n.t(key, options);
}

export const useTranslation = useReactI18nextTranslation;
export { i18n };
