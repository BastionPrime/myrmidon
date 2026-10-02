// Task PR sync wake guard (part E).
//
// The board dispatches a fresh run for a wake without asking whether the task
// the run would serve is already delivered. When a task's pull_request work
// products are all terminal with at least one merged and the task is still
// open, part C's periodic sweep is about to settle it; a run dispatched in
// that window only races the settle and burns a full adapter session on
// unchanged state. This module is the admission-side half of TASK-PR-SYNC: it
// answers "should this wake skip the run and let the settle happen" and wraps
// part C's decision (`shouldSuppressRunForIssue`, the fixed cross-part
// contract) with a bounded cache so the admission path does not pay a database
// hit per wake.
//
// The cache is a Map keyed by issueId holding { value, expiresAt }. A Map
// preserves insertion order, so re-inserting an issue on a hit moves it to the
// back: at the cap the oldest key — the least recently used — is evicted. The
// TTL is the sole invalidation: a settle or a work-product change lands within
// at most TTL seconds, and the settle path itself closes the task, which makes
// `shouldSuppressRunForIssue` return false afterwards, so the cache can only
// hold a suppress decision that no longer applies for a bounded window.

import type { Db } from "@paperclipai/db";
import { shouldSuppressRunForIssue } from "./guard.js";

/** Skip reason recorded on the skipped wakeup request (vendor skip mechanism). */
export const TASK_PR_SYNC_WAKE_SKIP_REASON = "wake_skipped_pr_settle_pending";

export const TASK_PR_SYNC_WAKE_GUARD_ENABLED_ENV = "MYRMIDON_TASK_PR_SYNC_WAKE_GUARD_ENABLED";
export const TASK_PR_SYNC_WAKE_GUARD_TTL_SEC_ENV = "MYRMIDON_TASK_PR_SYNC_WAKE_GUARD_TTL_SEC";

/** Default cache TTL: one sweep interval (see part C's default poll of 60 s). */
export const DEFAULT_TASK_PR_SYNC_WAKE_GUARD_TTL_SEC = 60;
export const MAX_TASK_PR_SYNC_WAKE_GUARD_TTL_SEC = 3600;
/** Upper bound on cached issues; the eviction makes the memory footprint O(cap). */
export const TASK_PR_SYNC_WAKE_GUARD_CACHE_CAP = 1000;

/** Master switch: unset or an unrecognized value keeps the guard on (a defect fix). */
export function readTaskPrSyncWakeGuardEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[TASK_PR_SYNC_WAKE_GUARD_ENABLED_ENV]?.trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "off" && raw !== "no";
}

export function readTaskPrSyncWakeGuardTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[TASK_PR_SYNC_WAKE_GUARD_TTL_SEC_ENV]?.trim();
  if (!raw || !/^\d+$/.test(raw)) return DEFAULT_TASK_PR_SYNC_WAKE_GUARD_TTL_SEC * 1000;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) return DEFAULT_TASK_PR_SYNC_WAKE_GUARD_TTL_SEC * 1000;
  return Math.min(value, MAX_TASK_PR_SYNC_WAKE_GUARD_TTL_SEC) * 1000;
}

interface TaskPrSyncWakeGuardEntry {
  value: boolean;
  expiresAt: number;
}

export interface TaskPrSyncWakeGuard {
  /**
   * The admission hook. True means: every PR of this issue is terminal with at
   * least one merged and the issue is not settled yet — skip the run, the
   * settle sweep owns the issue. False is always the safe answer.
   */
  shouldSuppressWake(issueId: string, db: Db): Promise<boolean>;
  /** Synchronous fast path: the cached decision, or null when not cached. */
  peek(issueId: string): boolean | null;
  /** Drops the cached entry (the settle path may call this when it settles). */
  invalidate(issueId: string): void;
  /** Test seam: number of underlying `shouldSuppressRunForIssue` calls. */
  readonly underlyingCalls: number;
}

export interface CreateTaskPrSyncWakeGuardInput {
  db?: Db;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  ttlMs?: number;
  cap?: number;
}

export function createTaskPrSyncWakeGuard(input: CreateTaskPrSyncWakeGuardInput = {}): TaskPrSyncWakeGuard {
  const ttlMs = input.ttlMs ?? readTaskPrSyncWakeGuardTtlMs(input.env);
  const cap = Math.max(1, input.cap ?? TASK_PR_SYNC_WAKE_GUARD_CACHE_CAP);
  const now = input.now ?? Date.now;
  const cache = new Map<string, TaskPrSyncWakeGuardEntry>();
  let underlyingCalls = 0;

  function peek(issueId: string): boolean | null {
    const entry = cache.get(issueId);
    if (!entry) return null;
    if (entry.expiresAt <= now()) {
      cache.delete(issueId);
      return null;
    }
    // LRU-ish: a hit moves the key to the back so eviction hits the oldest.
    cache.delete(issueId);
    cache.set(issueId, entry);
    return entry.value;
  }

  return {
    get underlyingCalls() {
      return underlyingCalls;
    },
    peek,
    invalidate(issueId: string) {
      cache.delete(issueId);
    },
    async shouldSuppressWake(issueId: string, db: Db): Promise<boolean> {
      const cached = peek(issueId);
      if (cached !== null) return cached;
      underlyingCalls += 1;
      const value = await shouldSuppressRunForIssue(issueId, db);
      cache.set(issueId, { value, expiresAt: now() + ttlMs });
      while (cache.size > cap) {
        const oldest = cache.keys().next();
        if (oldest.done) break;
        cache.delete(oldest.value);
      }
      return value;
    },
  } satisfies TaskPrSyncWakeGuard;
}
