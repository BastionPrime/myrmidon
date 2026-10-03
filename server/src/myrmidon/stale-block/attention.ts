// myrmidon(STALE-BLOCK): the operator signal behind a lifted stale block.
//
// The sweep rewrites task state on its own (status, comment, relations). The
// ticket's rule: the lead and the operator must SEE that it happened. The
// signal is the attention desk: ONE new sourceKind "stale_block" (the same
// one-call-site shape stack_update uses), generated on the fly from a
// process-level registry the sweep records into — no new notification store,
// exactly like the tracing-health signal registry.
//
// The registry is bounded (MYRMIDON_STALE_BLOCK_SIGNAL_TTL_MS, default
// 24 h): a lifted block is news for a day, then the card fades even if the
// process lives longer. The task's own system comment stays as the durable
// audit trail either way.

import type { AttentionSeverity } from "@paperclipai/shared";

/** How long a lifted-block card stays in the feed, in milliseconds. */
export const DEFAULT_STALE_BLOCK_SIGNAL_TTL_MS = 24 * 60 * 60 * 1000;
export const STALE_BLOCK_SIGNAL_TTL_ENV = "MYRMIDON_STALE_BLOCK_SIGNAL_TTL_MS";

export interface StaleBlockSignal {
  /** The task that was unblocked. */
  issueId: string;
  companyId: string;
  /** The task's identifier (e.g. "SB-123"), for the card title and href. */
  identifier: string | null;
  /** The task title, for the card body. */
  title: string | null;
  /** Neutral human text naming the dead reason(s), from the policy. */
  reasonTexts: string[];
  /** ISO timestamp of the sweep pass that lifted the block. */
  liftedAt: string;
}

interface RegisteredSignal extends StaleBlockSignal {
  registeredAt: number;
}

const signalsByCompany = new Map<string, Map<string, RegisteredSignal>>();

function readTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[STALE_BLOCK_SIGNAL_TTL_ENV]?.trim();
  if (!raw || !/^\d+$/.test(raw)) return DEFAULT_STALE_BLOCK_SIGNAL_TTL_MS;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : DEFAULT_STALE_BLOCK_SIGNAL_TTL_MS;
}

/** The sweep records one signal per unblocked task; idempotent per issue. */
export function recordStaleBlockSignal(signal: StaleBlockSignal, now: Date = new Date()): void {
  const byIssue = signalsByCompany.get(signal.companyId) ?? new Map<string, RegisteredSignal>();
  byIssue.set(signal.issueId, { ...signal, registeredAt: now.getTime() });
  signalsByCompany.set(signal.companyId, byIssue);
}

/** Signals not yet expired, oldest first; the feed turns each into one card. */
export function readStaleBlockSignals(
  companyId: string,
  now: Date = new Date(),
  env: NodeJS.ProcessEnv = process.env,
): StaleBlockSignal[] {
  const byIssue = signalsByCompany.get(companyId);
  if (!byIssue) return [];
  const ttlMs = readTtlMs(env);
  const out: StaleBlockSignal[] = [];
  for (const [issueId, signal] of byIssue) {
    if (now.getTime() - signal.registeredAt > ttlMs) {
      byIssue.delete(issueId);
      continue;
    }
    out.push(signal);
  }
  if (byIssue.size === 0) signalsByCompany.delete(companyId);
  return out;
}

/** Test helper: forget every recorded signal. */
export function resetStaleBlockSignals(): void {
  signalsByCompany.clear();
}

/** Stable dedup key: one card per lifted task, per lift. */
export function staleBlockSignalDedupKey(signal: StaleBlockSignal): string {
  return `stale_block:${signal.issueId}:${signal.liftedAt}`;
}

/** Why-now line for the card. */
export function staleBlockSignalWhyNow(signal: StaleBlockSignal): string {
  const reasons = signal.reasonTexts.length > 0 ? signal.reasonTexts.join("; ") : "its blocking reason ended";
  return `The stale-block watchdog lifted this task's dead block (${reasons}); the task is back in in_progress and needs an owner decision.`;
}

/** Severity: a routing change the machine made — visible, not alarming. */
export function staleBlockSignalSeverity(): AttentionSeverity {
  return "medium";
}