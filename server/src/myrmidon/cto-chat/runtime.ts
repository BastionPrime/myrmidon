// server/src/myrmidon/cto-chat/runtime.ts
//
// myrmidon(1.6-CTO-CHAT-B): the CTO chat planner over the database.
//
// This is the one place that knows HOW the planner reaches the board: the API
// key comes from the company's secrets (by the name the settings carry, never a
// value in the settings), the model comes from the instance settings, and the
// plan id is minted here. Everything below it is pure and takes what it needs as
// an argument, which is what makes the planner testable with a fake `fetch`
// alone.
//
// The key is read per call and does not outlive the call. Rotating it, changing
// the model or moving the address therefore takes effect on the next message,
// without a restart — the same property the OCR path (myrmidon EXT-CASE-OCR) has
// for its contour.

import { randomUUID } from "node:crypto";
import type { Db } from "@paperclipai/db";

import { secretService } from "../../services/secrets.js";
import {
  generateCtoChatPlan,
  type CtoChatPlanResult,
} from "./plan-generator.js";
import { ctoChatSettingsProblem, type CtoChatSettings } from "./settings.js";

/** A planning call the runtime could not serve: configuration, not a bad message. */
export class CtoChatRuntimeError extends Error {
  readonly code: "planner_disabled";
  constructor(message: string) {
    super(message);
    this.name = "CtoChatRuntimeError";
    this.code = "planner_disabled";
  }
}

export interface CtoChatRuntimeOptions {
  settings: CtoChatSettings;
  fetch: typeof fetch;
  /** Resolves the company secret named by the settings; null when it is missing. */
  readCompanyKey(companyId: string, secretName: string): Promise<string | null>;
  /** Mints the opaque plan id; a test passes a deterministic one. */
  mintPlanId?(): string;
}

export interface CtoChatRuntime {
  settings(): CtoChatSettings;
  mintPlanId(): string;
  /** Plan one message for one company. Never persists anything. */
  plan(input: { companyId: string; text: string; planId: string }): Promise<CtoChatPlanResult>;
}

export function createCtoChatRuntime(options: CtoChatRuntimeOptions): CtoChatRuntime {
  const settings = options.settings;
  const mintPlanId = options.mintPlanId ?? (() => randomUUID());
  return {
    settings: () => settings,
    mintPlanId,
    async plan(input) {
      const problem = ctoChatSettingsProblem(settings);
      if (problem) throw new CtoChatRuntimeError(problem);
      const apiKey = await options.readCompanyKey(input.companyId, settings.keySecret!);
      if (!apiKey) {
        throw new CtoChatRuntimeError(
          `the planning model key secret "${settings.keySecret ?? "—"}" is not available to this company`,
        );
      }
      return generateCtoChatPlan(
        { text: input.text, planId: input.planId },
        { fetch: options.fetch, settings, apiKey },
      );
    },
  };
}

/** The runtime over the database: company secrets for the key. */
export function createCtoChatRuntimeForDb(
  db: Db,
  settings: CtoChatSettings,
  overrides: { fetch?: typeof fetch; mintPlanId?: () => string } = {},
): CtoChatRuntime {
  const secrets = secretService(db);
  return createCtoChatRuntime({
    settings,
    fetch: overrides.fetch ?? fetch,
    mintPlanId: overrides.mintPlanId,
    async readCompanyKey(companyId, secretName) {
      const row = await secrets.getByName(companyId, secretName);
      if (!row) return null;
      return secrets.resolveSecretValue(companyId, row.id, "latest");
    },
  });
}