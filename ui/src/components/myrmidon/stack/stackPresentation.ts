// myrmidon(SUC): pure presentation helpers for the Stack screen.
//
// Kept free of React and i18n so the ordering, the "ours" summary and the
// default update plan are testable on their own. The screen translates the
// counts and labels itself.
import type { StackComponentState, StackSnapshot } from "./stackApi";

/**
 * A component lags when the release check counted at least one upstream
 * release ahead of our running version. A component without a probe or
 * without a check is never treated as lagging.
 */
export function isLagging(component: StackSnapshot): boolean {
  const behind = component.upstreamState?.behindBy;
  return typeof behind === "number" && behind >= 1;
}

/**
 * Lagging components first (the further behind, the higher), then by name so
 * the order stays stable between checks.
 */
export function sortStackComponents(components: readonly StackSnapshot[]): StackSnapshot[] {
  return [...components].sort((left, right) => {
    const leftLag = isLagging(left);
    const rightLag = isLagging(right);
    if (leftLag !== rightLag) return leftLag ? -1 : 1;
    if (leftLag && rightLag) {
      const leftBehind = left.upstreamState?.behindBy ?? 0;
      const rightBehind = right.upstreamState?.behindBy ?? 0;
      if (leftBehind !== rightBehind) return rightBehind - leftBehind;
    }
    return left.name.localeCompare(right.name);
  });
}

/** The parts of "ours" that are known: version, short commit, digest. */
export function localVersionParts(local: StackComponentState): string[] {
  const parts: string[] = [];
  if (local.version) parts.push(local.version);
  if (local.commit) parts.push(local.commit.slice(0, 12));
  if (local.digest) parts.push(local.digest);
  return parts;
}

/** True when no local version, commit or digest is known for the component. */
export function isLocalUnknown(local: StackComponentState): boolean {
  return localVersionParts(local).length === 0;
}

function oursSummary(component: StackSnapshot): string {
  const parts = localVersionParts(component.local);
  return parts.length > 0 ? parts.join(" \u00b7 ") : `unknown (${component.local.unknownReason ?? "no probe"})`;
}

/** Default task title for a scheduled update. */
export function buildStackUpdateTitle(component: StackSnapshot): string {
  const latest = component.upstreamState?.latest ?? "the latest release";
  return `Update ${component.name} to ${latest}`;
}

/**
 * Default plan text for the scheduled update: versions, our patches, the
 * notable upstream lines, the canary-then-production order and the rollback.
 * Written in English like the rest of the public code; the operator edits it
 * in the dialog before the draft is created.
 */
export function buildStackUpdatePlan(component: StackSnapshot): string {
  const upstream = component.upstreamState;
  const behind = upstream?.behindBy;
  const lines: string[] = [
    `## Stack update: ${component.name}`,
    "",
    "### Versions",
    `- Ours: ${oursSummary(component)}`,
    `- Upstream latest: ${upstream?.latest ?? "unknown"}`,
    `- Behind: ${typeof behind === "number" ? `${behind} release(s)` : "unknown"}`,
    `- Release source: ${component.releaseSource}`,
    "",
    "### Our patches",
    `- Overall: ${component.patchClosed?.state ?? "unknown"}${component.patchClosed?.reason ? ` (${component.patchClosed.reason})` : ""}`,
  ];
  if (component.local.patches.length === 0) {
    lines.push("- None carried.");
  } else {
    for (const patch of component.local.patches) {
      lines.push(
        `- ${patch.title}: ${patch.state}${patch.reason ? ` (${patch.reason})` : ""}${patch.ourVersion ? ` \u00b7 pinned on ${patch.ourVersion}` : ""}`,
      );
    }
  }
  lines.push("", "### Notable changes");
  const notes = upstream?.notes?.lines ?? [];
  if (notes.length === 0) {
    lines.push("- None captured in the last release excerpt.");
  } else {
    for (const note of notes) lines.push(`- ${note}`);
    if (upstream?.notes?.truncated) lines.push("- (Only the top lines are shown.)");
  }
  lines.push(
    "",
    "### Rollout order",
    "1. Canary: update one node, then confirm health and a sample run.",
    "2. Production: update the remaining nodes after the canary holds.",
    "",
    "### Rollback",
    "Redeploy the previous image digest, then re-check health before resuming traffic.",
  );
  return lines.join("\n");
}