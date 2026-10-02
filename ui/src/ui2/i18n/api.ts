// myrmidon(UI2-I18N): language preference client for the 2.0 UI tree.
//
// Wire contract (matches server/src/myrmidon/ui2-language/routes.ts):
//   GET /api/myrmidon/ui2/language/me -> { language: "en" | "ru", updatedAt: Date | null }
//   PUT /api/myrmidon/ui2/language/me { language } -> same shape
// The route is board-user scoped; an agent-key session gets 403 and the
// provider falls back to the local choice.
import { api } from "@/api/client";
import type { Ui2Language, Ui2LanguagePreference } from "@paperclipai/shared";

export interface Ui2LanguagePreferenceWire {
  language: Ui2Language;
  updatedAt: string | null;
}

export const ui2LanguageApi = {
  get: () => api.get<Ui2LanguagePreferenceWire>("/myrmidon/ui2/language/me"),
  put: (language: Ui2Language) =>
    api.put<Ui2LanguagePreferenceWire>("/myrmidon/ui2/language/me", { language }),
};

export function fromWire(preference: Ui2LanguagePreferenceWire): Ui2LanguagePreference {
  return {
    language: preference.language,
    updatedAt: preference.updatedAt ? new Date(preference.updatedAt) : null,
  };
}
