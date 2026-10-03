// server/src/myrmidon/monitoring/metrics/swarm-signals.ts
//
// myrmidon(1.7-METRICS): a process-local registry of live SWARM error
// signals, in the shape the stale-block and tracing-health attention
// registries use. Nothing here persists: the counters are recomputed on the
// fly by the metrics endpoint, so a restart simply zeroes the window.

import type { AttentionSeverity } from "@paperclipai/shared";

export interface SwarmClaimSignal {
  companyId: string;
  /** Human-neutral text of the signal, for the metrics help only. */
  reason: string;
  /** ISO timestamp of the sweep pass that recorded the signal. */
  recordedAt: string;
}

const signalsByCompany = new Map<string, Map<string, SwarmClaimSignal>>();

/** The sweep records one signal per detected condition; idempotent per key. */
export function recordSwarmClaimSignal(
  companyId: string,
  key: string,
  signal: SwarmClaimSignal,
): void {
  const byKey = signalsByCompany.get(companyId) ?? new Map<string, SwarmClaimSignal>();
  byKey.set(key, signal);
  signalsByCompany.set(companyId, byKey);
}

/** Live signals of one company; the metrics endpoint counts them. */
export function readSwarmClaimAttentionSignals(companyId: string): SwarmClaimSignal[] {
  return [...(signalsByCompany.get(companyId)?.values() ?? [])];
}

/** Test helper: forget every recorded signal. */
export function resetSwarmClaimSignals(): void {
  signalsByCompany.clear();
}

export function swarmClaimSignalSeverity(): AttentionSeverity {
  return "medium";
}
