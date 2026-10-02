// myrmidon(UI2-I18N): shared contract for the per-user board UI language
// preference (2.0 UI tree). The languages the fork ships UI catalogs for;
// English is the base and fallback. Agent-authored content (comments, run
// output) is never translated, and identifiers stay untranslated — this
// setting only selects the catalog the interface chrome renders from.
import { z } from "zod";

export const UI2_LANGUAGES = ["en", "ru"] as const;
export type Ui2Language = (typeof UI2_LANGUAGES)[number];

export const ui2LanguageSchema = z.enum(UI2_LANGUAGES);

export const upsertUi2LanguageSchema = z.object({
  language: ui2LanguageSchema,
});

export type UpsertUi2Language = z.infer<typeof upsertUi2LanguageSchema>;

export interface Ui2LanguagePreference {
  language: Ui2Language;
  updatedAt: Date | null;
}
