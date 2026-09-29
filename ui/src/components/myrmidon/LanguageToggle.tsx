// myrmidon(UI-RU): language toggle for the fork localization engine. Matches
// the ThemeToggle compact-menu-action row so the account menu stays uniform.
import { Languages } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  FORK_LANGUAGES,
  forkLanguageLabel,
  useAppLanguage,
  type ForkLanguage,
} from "@/i18n/myrmidon-i18n";
import { i18n } from "@/i18n";

interface LanguageToggleProps {
  className?: string;
  /** Dismiss the surrounding menu once the user has acted. */
  onAfterChange?: () => void;
}

export function LanguageToggle({ className, onAfterChange }: LanguageToggleProps) {
  const { language, setLanguage } = useAppLanguage();

  function select(next: ForkLanguage) {
    setLanguage(next);
    void i18n.changeLanguage(next);
    onAfterChange?.();
  }

  return (
    <div className={cn("flex flex-col gap-0.5 px-2.5 py-1", className)} role="group" aria-label="Language">
      {FORK_LANGUAGES.map((code) => (
        <button
          key={code}
          type="button"
          className={cn(
            "flex h-(--profile-popover-row-height) w-full items-center gap-(--profile-popover-row-gap) rounded-lg px-2.5 text-left text-(length:--text-compact) font-medium leading-(--profile-popover-label-line-height) transition-colors hover:bg-accent",
            language === code ? "text-foreground" : "text-muted-foreground",
          )}
          onClick={() => select(code)}
          aria-pressed={language === code}
        >
          <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">
            {language === code ? <Languages className="size-4" /> : <span className="size-4" />}
          </span>
          <span className="min-w-0 flex-1 truncate">{forkLanguageLabel(code)}</span>
        </button>
      ))}
    </div>
  );
}
