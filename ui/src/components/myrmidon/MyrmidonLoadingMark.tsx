// myrmidon(B1a): loading indicator — the Myrmidon ant mark with a plain
// opacity pulse, replacing the vendor's animated paperclip glyph. Source SVGs
// are the owner-approved brand-v2 export (navy on light, white on dark),
// copied as-is into ui/public/brand/myrmidon/; no attempt is made to animate
// the mark's outline. The pulse is `motion-safe:` so it stays a static mark
// under prefers-reduced-motion.
import { cn } from "../../lib/utils";

const MARK_LIGHT_SRC = "/brand/myrmidon/myrmidon-mark.svg";
const MARK_DARK_SRC = "/brand/myrmidon/myrmidon-mark-white.svg";
const PULSE_CLASS = "motion-safe:animate-pulse";

export function MyrmidonLoadingMark({ className }: { className?: string }) {
  return (
    <>
      <img
        src={MARK_LIGHT_SRC}
        alt=""
        aria-hidden="true"
        draggable={false}
        className={cn("dark:hidden", PULSE_CLASS, className)}
      />
      <img
        src={MARK_DARK_SRC}
        alt=""
        aria-hidden="true"
        draggable={false}
        className={cn("hidden dark:block", PULSE_CLASS, className)}
      />
    </>
  );
}
