// myrmidon(UI2-I18N): typed translation hook for the 2.0 UI tree.
//
// Wraps the vendor useTranslation so ui2 components render only through the
// ui2 catalog (the no-english-in-ru guard enforces this). The lookup is
// scoped to the "ui2" namespace the provider registers via addResourceBundle:
// components call t("nav.dashboard") and i18next resolves ui2:nav.dashboard.
import { useCallback } from "react";
import { useTranslation } from "@/i18n";
import type { TOptions } from "i18next";

export type Ui2Key =
  | `nav.${string}`
  | `common.${string}`
  | `language.${string}`
  | `status.${string}`
  | `agentRoles.${string}`
  | `tasks.${string}`
  | `time.${string}`;

export function useUi2T() {
  const { i18n: instance } = useTranslation();

  const t = useCallback(
    (key: Ui2Key, options?: TOptions) => instance.t(`ui2:${key}`, options ?? {}) as string,
    [instance],
  );

  return { t, language: instance.language };
}
