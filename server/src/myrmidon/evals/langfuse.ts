// server/src/myrmidon/evals/langfuse.ts
//
// myrmidon(1.6-EVALS): the optional Langfuse score export.
//
// Local scoring is always written to `eval_runs` first; this exporter sends
// the aggregate to a Langfuse instance only when the instance flag is on and
// a Langfuse contour is configured (the same settings shape as the LLM
// gateway contour). Export failures are recorded and never fail the run:
// Langfuse is observability, not a gate.
//
// Langfuse is part of the pinned stack (stack-registry, PR #331); the export
// uses its public ingestion API over fetch, so no new dependency is added.

export const EVALS_LANGFUSE_BASE_URL_ENV = "MYRMIDON_EVALS_LANGFUSE_BASE_URL";
export const EVALS_LANGFUSE_KEY_ENV = "MYRMIDON_EVALS_LANGFUSE_KEY";
export const EVALS_LANGFUSE_TIMEOUT_SEC_ENV = "MYRMIDON_EVALS_LANGFUSE_TIMEOUT_SEC";

export interface LangfuseExportSettings {
  enabled: boolean;
  baseUrl: string | null;
  /** Static public key; the deploy contour owns provisioning, not the code. */
  publicKey: string | null;
  timeoutMs: number;
}

export function readLangfuseExportSettings(env: NodeJS.ProcessEnv = process.env): LangfuseExportSettings {
  const baseUrl = env[EVALS_LANGFUSE_BASE_URL_ENV]?.trim() || null;
  const publicKey = env[EVALS_LANGFUSE_KEY_ENV]?.trim() || null;
  const timeoutRaw = Number(env[EVALS_LANGFUSE_TIMEOUT_SEC_ENV]?.trim() ?? "");
  const timeoutSec = Number.isInteger(timeoutRaw) && timeoutRaw >= 5 && timeoutRaw <= 120 ? timeoutRaw : 30;
  return { enabled: Boolean(baseUrl && publicKey), baseUrl, publicKey, timeoutMs: timeoutSec * 1000 };
}

export interface EvalsScoreExporter {
  exportRun(input: {
    runId: string;
    companyId: string;
    role: string;
    subject: string;
    scores: { scorePercent: number; totalScore: number; maxScore: number; taskCount: number };
    verdict: string | null;
  }): Promise<void>;
}

/** A no-op exporter for the default local-only path. */
export const noopScoreExporter: EvalsScoreExporter = { exportRun: async () => undefined };

/**
 * The Langfuse exporter: one POST per run with the aggregate score, using
 * the dataset-item style ingestion endpoint. Failures resolve without
 * throwing (logged by the caller through the run record when they matter).
 */
export function createLangfuseScoreExporter(deps: {
  fetch: typeof fetch;
  baseUrl: string;
  publicKey: string;
  timeoutMs: number;
  onError?(message: string): void;
}): EvalsScoreExporter {
  return {
    exportRun: async (input) => {
      const url = deps.baseUrl.replace(/\/+$/, "") + "/api/public/ingestion";
      const eventAt = new Date().toISOString();
      const payload = {
        batch: [
          {
            id: input.runId,
            type: "trace-create",
            timestamp: eventAt,
            name: `eval-run:${input.role}`,
            metadata: { subject: input.subject, taskCount: input.scores.taskCount },
          },
          {
            id: `${input.runId}-score`,
            type: "score-create",
            timestamp: eventAt,
            traceId: input.runId,
            name: "eval-score-percent",
            value: input.scores.scorePercent,
            comment: input.verdict ? `verdict: ${input.verdict}` : null,
          },
        ],
      };
      try {
        const response = await deps.fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Basic ${Buffer.from(`${deps.publicKey}:`).toString("base64")}`,
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(deps.timeoutMs),
        });
        if (!response.ok) {
          deps.onError?.(`Langfuse export failed with HTTP ${response.status}`);
        }
      } catch (error) {
        deps.onError?.(`Langfuse export failed: ${(error as Error).message}`);
      }
    },
  };
}
