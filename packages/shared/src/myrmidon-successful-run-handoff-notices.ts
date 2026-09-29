// myrmidon(B1): single definition of the two successful-run-handoff recovery
// notice bodies. The server posts them as system comments, and the board UI
// recognizes those comments by exact text (to render the alert card instead of
// a plain markdown comment). Keeping one copy here means a future rename cannot
// silently make one side stop matching the other.
//
// Comments already stored in a database were posted under the pre-rename
// product name ("Paperclip ..."). They stay in the database forever, so every
// matcher below accepts both the current and the pre-rename body. Do not edit
// the LEGACY_* literals for a later rename either: add another legacy literal
// and extend the matchers instead.
//
// The product name is a literal here because this package has no access to the
// server-only product name module; the server guard test
// (server/src/myrmidon/product.myrmidon.test.ts) fails if the two drift.

export const SUCCESSFUL_RUN_HANDOFF_REQUIRED_NOTICE_BODY =
  "Myrmidon needs a disposition before this issue can continue.";
export const SUCCESSFUL_RUN_HANDOFF_EXHAUSTED_NOTICE_BODY =
  "Myrmidon could not resolve this issue's missing disposition automatically. The source assignment is unchanged and a board decision is required.";

/** Exact body the "needs a disposition" notice carried before the rename. */
export const LEGACY_SUCCESSFUL_RUN_HANDOFF_NOTICE_BODY_PAPERCLIP =
  "Paperclip needs a disposition before this issue can continue.";
/** Exact body the "could not resolve" notice carried before the rename. */
export const LEGACY_SUCCESSFUL_RUN_HANDOFF_EXHAUSTED_NOTICE_BODY_PAPERCLIP =
  "Paperclip could not resolve this issue's missing disposition automatically. The source assignment is unchanged and a board decision is required.";

/** Every exact body that counts as the "needs a disposition" notice, current first. */
export const SUCCESSFUL_RUN_HANDOFF_REQUIRED_NOTICE_BODIES = [
  SUCCESSFUL_RUN_HANDOFF_REQUIRED_NOTICE_BODY,
  LEGACY_SUCCESSFUL_RUN_HANDOFF_NOTICE_BODY_PAPERCLIP,
] as const;

/** Every exact body that counts as the "could not resolve" notice, current first. */
export const SUCCESSFUL_RUN_HANDOFF_EXHAUSTED_NOTICE_BODIES = [
  SUCCESSFUL_RUN_HANDOFF_EXHAUSTED_NOTICE_BODY,
  LEGACY_SUCCESSFUL_RUN_HANDOFF_EXHAUSTED_NOTICE_BODY_PAPERCLIP,
] as const;

/** True when the whole comment is the "needs a disposition" notice, current or pre-rename text. */
export function matchesSuccessfulRunHandoffRequiredNoticeBody(text: string): boolean {
  const trimmed = text.trim();
  return SUCCESSFUL_RUN_HANDOFF_REQUIRED_NOTICE_BODIES.some((body) => body === trimmed);
}

/** True when the whole comment is the "could not resolve" notice, current or pre-rename text. */
export function matchesSuccessfulRunHandoffExhaustedNoticeBody(text: string): boolean {
  const trimmed = text.trim();
  return SUCCESSFUL_RUN_HANDOFF_EXHAUSTED_NOTICE_BODIES.some((body) => body === trimmed);
}
