// myrmidon(UI2-I18N): catalog re-exports for the 2.0 UI tree.
//
// The catalogs themselves live in en.ts / ru.ts. The provider (../index.tsx)
// registers them on the vendor i18next instance via addResourceBundle under
// the "ui2" namespace — no vendor file is touched.
export { en, type Ui2Catalog } from "./en";
export { ru } from "./ru";

export const UI2_NAMESPACE = "ui2" as const;
