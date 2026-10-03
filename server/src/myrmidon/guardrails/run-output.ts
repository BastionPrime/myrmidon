// server/src/myrmidon/guardrails/run-output.ts
//
// myrmidon(1.6-GRD): the single run-output hook the heartbeat finalization
// calls. It reads the env switch, detects on the run's final text (the same
// text that lands in the issue comment / result), and journals flag-only
// events. The hot files (heartbeat.ts, issues.ts) get one import line and
// one guarded call line each, both behind `// myrmidon(1.6-GRD)` markers;
// every bit of logic lives here.
//
// Off by default (MYRMIDON_GUARDRAILS_OUTPUT_ENABLED); the flag is turned on
// at rollout. Nothing is masked and nothing is blocked in 1.6.1.

import type { Db } from "@paperclipai/db";
import { recordRunOutputGuardrailEvents } from "./events.js";

/** Options the heartbeat passes down; all fields optional in tests. */
export interface GuardrailRunOutputInput {
  db: Db;
  companyId: string;
  runId: string;
  issueId: string | null;
  /** The final text of the run — what the comment would carry. */
  text: string | null;
  env?: NodeJS.ProcessEnv;
  now?(): Date;
}

export async function guardrailsOnRunOutput(input: GuardrailRunOutputInput) {
  return recordRunOutputGuardrailEvents(input.db, {
    companyId: input.companyId,
    runId: input.runId,
    issueId: input.issueId,
    text: input.text,
    now: input.now ?? (() => new Date()),
    env: input.env,
  });
}
