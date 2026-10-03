// server/src/myrmidon/foraging/service.ts
//
// myrmidon(1.6-FORAGE): the periodic comparison pass.
//
// One pass, per company:
//   1. read the enabled sources of the company, oldest check first;
//   2. for each source, take a snapshot through the injected reader (the only
//      place that touches the network, so the pass itself is testable);
//   3. compare with the previous snapshot. The first read of a source stores the
//      baseline and reports no change; a changed source produces a finding;
//   4. hand the finding to the skill-candidate port. While the port is absent
//      (SKILL-LIFECYCLE not merged) the finding stays `unverified` and the pass
//      continues; a refusal from a present port marks it `rejected`;
//   5. stop the pass once the cost estimate reaches the budget ceiling. The stop
//      is a normal outcome: the sources after the stop are untouched and the
//      next pass starts with them.
//
// Failures are per source: one unreachable host writes `last_error` on its row
// and the pass continues with the next source. Nothing here throws at the pass
// level, so a broken source never stops the sweep.

import { logger } from "../../middleware/logger.js";
import {
  buildSourceResult,
  decideForagingBudget,
  estimateCostCents,
  normalizeSnapshot,
  skillKeyForRole,
  type ForagingBudgetState,
  type ForagingCandidatePort,
  type ForagingSweepResult,
  type ForagingSourceRef,
} from "./domain.js";
import type { ForagingStore } from "./store.js";

export interface ForagingReaderResult {
  /** The raw text of the source; the pass normalizes it. */
  text: string;
  /** How many bytes were fetched, for the cost estimate. */
  bytes: number;
}

/** Reads one source. The only network boundary of the pass; injected in tests. */
export interface ForagingReader {
  read(source: ForagingSourceRef, signal: AbortSignal): Promise<ForagingReaderResult>;
}

export interface ForagingServiceDeps {
  store: ForagingStore;
  reader: ForagingReader;
  candidatePort: ForagingCandidatePort;
  settings: {
    budget: { maxCostCents: number; enabled: boolean };
  };
  now?: () => Date;
  log?: Pick<typeof logger, "info" | "warn" | "error">;
}

export interface ForagingService {
  /** One comparison pass over one company. Never throws. */
  runPass(companyId: string): Promise<ForagingSweepResult>;
  /** The budget state of the current UTC month for the screen. */
  budgetState(companyId: string): Promise<{ spentCents: number; maxCostCents: number; enabled: boolean }>;
}

/** The UTC month window the pass spends against. */
function currentUtcMonthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
}

export function createForagingService(deps: ForagingServiceDeps): ForagingService {
  const store = deps.store;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? logger;
  const budget = deps.settings.budget;

  const emptyResult = (): ForagingSweepResult => ({
    sourcesRead: 0,
    findings: 0,
    candidates: 0,
    spentCents: 0,
    stoppedByBudget: false,
    errors: 0,
  });

  return {
    async budgetState(companyId) {
      const nowDate = now();
      const monthFindings = await store.monthFindingCount(companyId, currentUtcMonthStart(nowDate));
      // The stored finding count is the observable trace of past passes; the
      // ceiling stays the configured one, so the screen can show how close the
      // company is to the limit between passes.
      const spentCents = deps.settings.budget.enabled
        ? Math.min(monthFindings * estimateCostCents(1024), deps.settings.budget.maxCostCents)
        : 0;
      return { spentCents, maxCostCents: budget.maxCostCents, enabled: budget.enabled };
    },

    async runPass(companyId) {
      const result = emptyResult();
      const startedAt = now();
      let sources: ForagingSourceRef[];
      try {
        sources = await store.enabledSources(companyId);
      } catch (err) {
        log.error({ err, companyId }, "foraging: could not list sources");
        return result;
      }
      const state: ForagingBudgetState = { spentCents: 0 };

      for (const source of sources) {
        // The byte size is unknown before the read; budget the read by the
        // accepted answer cap, then settle the real cost after it. A source
        // that would exceed the ceiling is not read at all.
        if (budget.enabled && state.spentCents >= budget.maxCostCents) {
          result.stoppedByBudget = true;
          log.info({ companyId, sourceId: source.id }, "foraging: pass stopped by the budget");
          break;
        }

        const controller = new AbortController();
        let read: ForagingReaderResult;
        try {
          read = await deps.reader.read(source, controller.signal);
        } catch (err) {
          result.errors += 1;
          const message = err instanceof Error ? err.message : String(err);
          await store.saveRead(companyId, source.id, { lastCheckedAt: now(), lastError: message });
          log.warn({ err, companyId, sourceId: source.id }, "foraging: source read failed");
          continue;
        }

        const costCents = estimateCostCents(read.bytes);
        const decision = decideForagingBudget(budget, state, costCents);
        if (!decision.allowed) {
          result.stoppedByBudget = true;
          log.info({ companyId, sourceId: source.id }, "foraging: pass stopped by the budget");
          break;
        }
        state.spentCents = decision.spentCents;
        result.spentCents = state.spentCents;
        result.sourcesRead += 1;

        const current = normalizeSnapshot(read.text);
        let candidateRef: string | null = null;
        if (deps.candidatePort.available && source.lastSnapshot !== null) {
          const diffReady = buildSourceResult({
            previous: source.lastSnapshot,
            current,
            role: source.role,
            candidateRef: null,
            portAvailable: false,
          });
          if (diffReady.finding) {
            try {
              candidateRef = await deps.candidatePort.createFindingCandidate({
                companyId,
                sourceId: source.id,
                role: source.role,
                url: source.url,
                skillKey: skillKeyForRole(source.role),
                summary: diffReady.finding.summary,
                diff: diffReady.finding.diff,
                detectedAt: startedAt,
              });
            } catch (err) {
              result.errors += 1;
              log.warn({ err, companyId, sourceId: source.id }, "foraging: candidate port failed");
            }
          }
        }

        const outcome = buildSourceResult({
          previous: source.lastSnapshot,
          current,
          role: source.role,
          candidateRef,
          portAvailable: deps.candidatePort.available,
        });

        const checkedAt = now();
        await store.saveSnapshot(companyId, source.id, {
          lastSnapshot: current,
          lastSnapshotAt: checkedAt,
          lastCheckedAt: checkedAt,
          lastError: outcome.error,
        });

        if (outcome.finding) {
          await store.insertFinding({
            companyId,
            sourceId: source.id,
            role: source.role,
            status: outcome.finding.status,
            summary: outcome.finding.summary,
            diff: outcome.finding.diff,
            skillKey: skillKeyForRole(source.role),
            candidateRef: outcome.candidateRef,
            reason: outcome.error,
            detectedAt: checkedAt,
          });
          result.findings += 1;
          if (outcome.candidateRef) result.candidates += 1;
        }
      }

      log.info(
        {
          companyId,
          sourcesRead: result.sourcesRead,
          findings: result.findings,
          candidates: result.candidates,
          spentCents: result.spentCents,
          stoppedByBudget: result.stoppedByBudget,
          errors: result.errors,
        },
        "foraging pass done",
      );
      return result;
    },
  };
}