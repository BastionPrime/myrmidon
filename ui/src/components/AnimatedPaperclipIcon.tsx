import { cn } from "../lib/utils";
import { MyrmidonLoadingMark } from "./myrmidon/MyrmidonLoadingMark"; // myrmidon(B1a)

// myrmidon(B1a): the vendor's animated paperclip glyph is replaced by the
// Myrmidon ant mark (see MyrmidonLoadingMark). The vendor component names are
// kept so the many Suspense fallbacks and the auth screen that render them
// stay untouched; what a person sees is the ant.
export function AnimatedPaperclipIcon({ className }: { className?: string }) {
  return <MyrmidonLoadingMark className={className} />;
}

/** Full-page loading state: a large, centered, pulsing Myrmidon ant mark. */
export function PaperclipLoading({ className }: { className?: string }) {
  return (
    <div
      role="status"
      className={cn("flex min-h-dvh w-full items-center justify-center", className)}
    >
      <AnimatedPaperclipIcon className="h-24 w-24" />
      <span className="sr-only">Loading…</span>
    </div>
  );
}
