// myrmidon(L2): combines wake classification with the operator setting into
// the single question getExecutionBlocker's callers ask. See
// wake-classification.ts, config.ts and docs/myrmidon/DIVERGENCE.md "L2".
import { isExplicitWake, type WakeClassificationInput } from "./wake-classification.js";
import { settledHoldsBlockExplicitWakes } from "./config.js";

/**
 * True when `wake` should be allowed to ignore a settled (resolved/
 * cancelled) recovery action's closed "do not replay" disposition. Pass the
 * result as `explicitWake` to `getExecutionBlocker`.
 */
export function bypassesSettledHold(wake: WakeClassificationInput): boolean {
  return isExplicitWake(wake) && !settledHoldsBlockExplicitWakes();
}
