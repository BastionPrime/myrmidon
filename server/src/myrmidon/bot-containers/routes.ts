// server/src/myrmidon/bot-containers/routes.ts
//
// myrmidon(W2b): the API behind the "Container" section of the agent card.
//
//   GET  /api/myrmidon/agents/:id/bot-container/status
//   POST /api/myrmidon/agents/:id/bot-container/apply
//
// Both are gated behind MYRMIDON_BOT_CONTAINERS (off by default): while it is off,
// status still answers (so the card can say so) but reports `enabled: false` and
// never touches the container runtime, and apply is refused with 409. Board
// actors only — an agent never changes its own card or restarts its own gateway
// (same rule as agent-self-update.ts).
//
// "Apply now" reconciles the SAVED card (applyBotContainerNow reads the agent row,
// not the form), so a card with unsaved edits has to be saved first; the UI
// enforces that. This file stays free of services/ imports: everything that
// needs the database or the maintenance service comes in through
// BotContainerRoutesDeps, so it can be tested with plain fakes (see index.ts for
// the real wiring).

import { Router, type Request } from "express";
import { conflict, notFound } from "../../errors.js";
import { logger } from "../../middleware/logger.js";
import { assertBoard, assertCompanyAccess, hasCompanyAccess } from "../../routes/authz.js";
import { BOT_IMAGE_ALLOWLIST_ENV } from "./docker-driver.js";
import {
  botKeyForAgent,
  isBotContainersEnabled,
  readBotContainerAgentConfig,
} from "./agent-config.js";
import type { ApplyBotContainerOutcome, BotContainerAgent, BotContainerRuntimeDeps } from "./index.js";
import { isImageAllowed, parseImageAllowlist } from "./template.js";
import type { BotContainerState } from "./driver.js";

export interface BotContainerRouteAgent {
  id: string;
  companyId: string;
  adapterType: string;
  adapterConfig: Record<string, unknown>;
}

export interface BotContainerRoutesDeps {
  /** The stored agent row, or null. Reads the raw card: the apply reads the same. */
  getAgent(id: string): Promise<BotContainerRouteAgent | null>;
  /** Extra permission check for changing this agent's configuration; throws to deny. */
  assertCanUpdateAgent?(req: Request, agent: BotContainerRouteAgent): Promise<void>;
  /** The reconciler's runtime (driver, profile compiler, maintenance, network), or
   *  null while the instance has not wired one. */
  getRuntime(): BotContainerRuntimeDeps | null;
  /** applyBotContainerNow (index.ts). Injected, not imported: index.ts imports
   *  this file for its real wiring, and pulls in the services this file avoids. */
  applyNow(
    agent: BotContainerAgent,
    runtime: BotContainerRuntimeDeps,
    opts: { env?: NodeJS.ProcessEnv },
  ): Promise<ApplyBotContainerOutcome>;
  /** Read per request; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

export interface BotContainerStatusResponse {
  /** MYRMIDON_BOT_CONTAINERS is on for this instance. */
  enabled: boolean;
  /** The instance has a container runtime wired (driver and profile compiler). */
  runtimeConfigured: boolean;
  /** The saved card is an enabled, complete hermes_gateway container config. */
  eligible: boolean;
  /** Why the saved card is not eligible; null when it is. */
  reason: string | null;
  /** MYRMIDON_BOT_IMAGE_ALLOWLIST globs. Empty means no image is allowed at all. */
  imageAllowlist: string[];
  /** Whether the saved image matches the allowlist; null when there is no saved image. */
  imageAllowed: boolean | null;
  /** The live container, or null when it was not asked (flag off, no runtime, other adapter) or could not be. */
  container: { state: BotContainerState; image: string | null } | null;
  /** Set when the runtime was asked and did not answer. */
  containerError: string | null;
}

export type BotContainerApplyResponse = { outcome: Exclude<ApplyBotContainerOutcome, { kind: "not_applicable" }> };

const MAX_MESSAGE_CHARS = 500;

function clip(message: string): string {
  return message.length > MAX_MESSAGE_CHARS ? `${message.slice(0, MAX_MESSAGE_CHARS)}…` : message;
}

export function botContainerRoutes(deps: BotContainerRoutesDeps) {
  const router = Router();
  const envNow = () => deps.env ?? process.env;

  /** 404 for both "no such agent" and "someone else's agent", so ids cannot be probed across companies. */
  async function loadAgent(req: Request): Promise<BotContainerRouteAgent> {
    const agent = await deps.getAgent(req.params.id as string);
    if (!agent || !hasCompanyAccess(req, agent.companyId)) throw notFound("Agent not found");
    assertCompanyAccess(req, agent.companyId);
    return agent;
  }

  router.get("/myrmidon/agents/:id/bot-container/status", async (req, res) => {
    assertBoard(req);
    const agent = await loadAgent(req);
    const env = envNow();
    const enabled = isBotContainersEnabled(env);
    const allowlist = parseImageAllowlist(env[BOT_IMAGE_ALLOWLIST_ENV]);
    const parsed = readBotContainerAgentConfig(agent.adapterType, agent.adapterConfig);
    const savedImage = (agent.adapterConfig.container as { image?: unknown } | undefined)?.image;
    const runtime = deps.getRuntime();

    const body: BotContainerStatusResponse = {
      enabled,
      runtimeConfigured: runtime !== null,
      eligible: parsed.ok,
      reason: parsed.ok ? null : parsed.reason,
      imageAllowlist: allowlist,
      imageAllowed:
        agent.adapterType === "hermes_gateway" && typeof savedImage === "string" && savedImage.trim().length > 0
          ? isImageAllowed(savedImage.trim(), allowlist)
          : null,
      container: null,
      containerError: null,
    };

    const botKey = botKeyForAgent(agent.id);
    // Asked even when the card says "disabled": a container may still be running from before.
    if (enabled && runtime && botKey && agent.adapterType === "hermes_gateway") {
      try {
        const status = await runtime.driver.status(botKey);
        body.container = { state: status.state, image: status.image ?? null };
      } catch (err) {
        logger.warn({ err, agentId: agent.id }, "bot container status query failed");
        body.containerError = "The container runtime did not answer.";
      }
    }
    res.json(body);
  });

  router.post("/myrmidon/agents/:id/bot-container/apply", async (req, res) => {
    assertBoard(req);
    const agent = await loadAgent(req);
    await deps.assertCanUpdateAgent?.(req, agent);
    const env = envNow();
    if (!isBotContainersEnabled(env)) {
      throw conflict("Bot containers are not enabled on this instance", { code: "bot_containers_disabled" });
    }
    const runtime = deps.getRuntime();
    if (!runtime) {
      // Answered directly, not thrown: the shared error handler reports every
      // thrown 5xx as a crash, and this is a configuration state, not a fault.
      res.status(503).json({
        error: "The bot container runtime is not configured on this instance",
        code: "bot_container_runtime_unavailable",
      });
      return;
    }
    const outcome = await deps.applyNow(
      { agentId: agent.id, adapterType: agent.adapterType, adapterConfig: agent.adapterConfig },
      runtime,
      { env },
    );
    if (outcome.kind === "not_applicable") {
      throw conflict(clip(outcome.reason), { code: "bot_container_not_applicable" });
    }
    if (outcome.kind === "error") {
      // reconcileBot already wrote the failure to the activity sink; the person
      // pressing the button needs to see why it did not apply.
      // `error` is what the UI's request client turns into the exception message.
      const message = clip(outcome.message);
      res.status(502).json({ error: message, outcome: { kind: "error", message } });
      return;
    }
    res.json({ outcome } satisfies BotContainerApplyResponse);
  });

  return router;
}
