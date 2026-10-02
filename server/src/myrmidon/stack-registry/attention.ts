// Stack registry (SUA, part B): the attention cards for the "needs me" feed.
// Pure: it reads the cached stack document and returns neutral card
// descriptors; the vendor attention service turns them into feed items (one
// call site with a `myrmidon(SUB)` marker). A card appears only for a component
// that lags behind its upstream release or whose latest release changed since
// the previous check.

import type { AttentionSeverity } from "@paperclipai/shared";
import type { StackDocument, StackPatchClosedState } from "./domain.js";

/** Cap for the release-note excerpt carried on the card. */
export const STACK_ATTENTION_EXCERPT_MAX = 300;

export interface StackAttentionCard {
  component: string;
  title: string;
  latest: string;
  ourVersion: string | null;
  behindBy: number | null;
  severity: AttentionSeverity;
  whyNow: string;
  summaryExcerpt: string | null;
  dedupKey: string;
  activityAt: string;
  patchState: StackPatchClosedState | null;
  metadata: Record<string, unknown>;
}

function excerpt(lines: readonly string[]): string | null {
  if (lines.length === 0) return null;
  const joined = lines.join(" \u00b7 ");
  return joined.length > STACK_ATTENTION_EXCERPT_MAX
    ? `${joined.slice(0, STACK_ATTENTION_EXCERPT_MAX - 1)}\u2026`
    : joined;
}

/** Should this component surface a card? */
export function stackComponentNeedsAttention(component: StackDocument["components"][number]): boolean {
  const upstream = component.upstreamState;
  if (!upstream || !upstream.latest) return false;
  const behind = upstream.behindBy != null && upstream.behindBy >= 1;
  const newLatest = upstream.previousLatest != null && upstream.previousLatest !== upstream.latest;
  return behind || newLatest;
}

/**
 * Build the attention cards for one cached document. Ordered by component name
 * so the feed stays stable between checks.
 */
export function buildStackAttentionCards(doc: StackDocument): StackAttentionCard[] {
  const cards: StackAttentionCard[] = [];
  for (const component of doc.components) {
    if (!stackComponentNeedsAttention(component)) continue;
    const upstream = component.upstreamState!;
    const latest = upstream.latest!;
    const behindBy = upstream.behindBy ?? null;
    const behind = behindBy != null && behindBy >= 1;
    const ourVersion = component.local.version ?? component.local.commit;
    const hasSecurity = upstream.notes?.hasSecurity === true;
    const notes = upstream.notes?.lines ?? [];
    // Stable while the latest does not change: the release publish time when
    // the source has one, otherwise the moment this latest was first seen. A
    // dismissal keyed to a fixed activity time does not expire on every check.
    const activityAt = upstream.latestPublishedAt ?? upstream.firstSeenAt ?? doc.checkedAt ?? new Date(0).toISOString();
    const whyNow = behind
      ? `Upstream release ${latest} is ${behindBy} release(s) ahead of the running version (${ourVersion ?? "unknown"}).`
      : `A new upstream release ${latest} appeared since the last check.`;
    cards.push({
      component: component.name,
      title: `${component.name} ${latest}`,
      latest,
      ourVersion,
      behindBy,
      severity: hasSecurity ? "high" : "medium",
      whyNow,
      summaryExcerpt: excerpt(notes),
      dedupKey: `stack:${component.name}:${latest}`,
      activityAt,
      patchState: component.patchClosed?.state ?? null,
      metadata: {
        component: component.name,
        ourVersion,
        latest,
        behindBy,
        patchClosed: component.patchClosed?.state ?? "unknown",
        patchReason: component.patchClosed?.reason ?? null,
        hasSecurity,
        notes,
      },
    });
  }
  return cards.sort((left, right) => left.component.localeCompare(right.component));
}