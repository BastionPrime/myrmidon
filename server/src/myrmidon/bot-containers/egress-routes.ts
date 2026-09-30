// server/src/myrmidon/bot-containers/egress-routes.ts
//
// myrmidon(EGRESS-B): the API behind the egress lists — the "Egress" section of
// a project and the egress fields of a bot's card.
//
//   GET  /api/myrmidon/companies/:companyId/bot-egress/policies
//   PUT  /api/myrmidon/companies/:companyId/bot-egress/projects/:projectId
//   PUT  /api/myrmidon/companies/:companyId/bot-egress/bots/:botKey
//   GET  /api/myrmidon/companies/:companyId/bot-egress/refusals
//   GET  /api/myrmidon/bot-egress/policy           (the proxy itself)
//
// The board edits; the proxy reads. The last route is the document the proxy
// fetches (`grep`-free, unlike the journal), and it is guarded by a shared token
// (`MYRMIDON_BOT_EGRESS_TOKEN`) rather than board auth, because the caller is a
// service and not a person. With no token set the route answers 503: an instance
// that has not decided to publish its lists publishes nothing.
//
// The refusals route is a read-through to the proxy's own refusal feed: the
// durable record is the journal, so nothing is stored here (no new table, no
// write path the board would have to keep). It is what makes a refusal visible
// in the interface.
//
// This file stays free of database and service imports: everything comes in
// through BotEgressRoutesDeps, so it is testable with plain fakes (see
// egress-routes.myrmidon.test.ts; the real wiring is egress-wiring.ts).

import { Router, type Request } from "express";
import { badRequest, conflict, notFound, unauthorized } from "../../errors.js";
import { logger } from "../../middleware/logger.js";
import { assertBoard, assertCompanyAccess, hasCompanyAccess } from "../../routes/authz.js";
import {
  BOT_EGRESS_TOKEN_ENV,
  buildEgressPolicyDocument,
  EgressPolicyInputError,
  effectiveProjectEgressMode,
  formatEgressDestination,
  parseEgressAllowlistInput,
  projectPolicySaveRefusal,
  readBotEgressPolicy,
  readProjectEgressPolicy,
  type EgressPolicyRow,
  type EgressProjectMode,
} from "./egress-policy.js";

/** What the routes need from the database. The order of the rows does not matter. */
export interface BotEgressStore {
  /** Every policy row of one company. */
  list(companyId: string): Promise<EgressPolicyRow[]>;
  /** Every policy row of the instance (the proxy serves the whole board).
   *  A `project` row carries the project's name in `project` — the document the
   *  proxy reads is keyed by the name the journal shows. */
  listAll(): Promise<EgressPolicyRow[]>;
  upsertProject(
    companyId: string,
    projectId: string,
    policy: { mode: EgressProjectMode; verified: boolean; allow: string[] },
  ): Promise<void>;
  upsertBot(companyId: string, botKey: string, policy: { project: string; allow: string[] }): Promise<void>;
  /** project id -> name, for the company. */
  projectNames(companyId: string): Promise<Map<string, string>>;
  /** Whether the company has such a project (the route refuses an unknown id). */
  hasProject(companyId: string, projectId: string): Promise<boolean>;
}

export interface BotEgressRoutesDeps {
  store: BotEgressStore;
  /** The proxy's refusal feed, already parsed; throws when the proxy cannot be reached. */
  readRefusals(): Promise<unknown[]>;
  env?: NodeJS.ProcessEnv;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A bot key (the agent id the driver uses) or a plain project name. No slashes. */
const TARGET_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

export interface ProjectEgressView {
  projectId: string;
  name: string;
  mode: EgressProjectMode;
  /** What the proxy would actually do: `block` only with a verified, non-empty list. */
  effectiveMode: EgressProjectMode;
  verified: boolean;
  allow: string[];
}

export interface BotEgressView {
  botKey: string;
  project: string;
  allow: string[];
}

export interface BotEgressPoliciesResponse {
  projects: ProjectEgressView[];
  bots: BotEgressView[];
}

function projectView(projectId: string, name: string, row: EgressPolicyRow | undefined): ProjectEgressView {
  const policy = readProjectEgressPolicy(row ?? null);
  return {
    projectId,
    name,
    mode: policy.mode,
    effectiveMode: effectiveProjectEgressMode(policy),
    verified: policy.verified,
    allow: policy.allow.map(formatEgressDestination),
  };
}

function readAllowInput(value: unknown): string[] {
  const parsed = parseEgressAllowlistInput(value ?? []);
  return parsed.map(formatEgressDestination);
}

function readModeInput(value: unknown): EgressProjectMode {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "log";
  if (text !== "log" && text !== "block") {
    throw new EgressPolicyInputError('mode must be "log" or "block"');
  }
  return text;
}

export function botEgressRoutes(deps: BotEgressRoutesDeps) {
  const router = Router();
  const envNow = () => deps.env ?? process.env;

  /** The company of the path, with the same access rule the other myrmidon routes use. */
  function companyIdOf(req: Request): string {
    const companyId = req.params.companyId as string;
    if (!hasCompanyAccess(req, companyId)) throw notFound("Company not found");
    assertCompanyAccess(req, companyId);
    return companyId;
  }

  router.get("/myrmidon/companies/:companyId/bot-egress/policies", async (req, res) => {
    assertBoard(req);
    const companyId = companyIdOf(req);
    const [rows, names] = await Promise.all([deps.store.list(companyId), deps.store.projectNames(companyId)]);
    const byProject = new Map<string, EgressPolicyRow>();
    const bots: BotEgressView[] = [];
    for (const row of rows) {
      if (row.scope === "project") byProject.set(row.targetId, row);
      else if (row.scope === "bot") {
        const policy = readBotEgressPolicy(row);
        bots.push({
          botKey: row.targetId,
          project: policy.project,
          allow: policy.allow.map(formatEgressDestination),
        });
      }
    }
    const projects: ProjectEgressView[] = [...names.entries()]
      .map(([projectId, name]) => projectView(projectId, name, byProject.get(projectId)))
      .sort((left, right) => left.name.localeCompare(right.name));
    res.json({ projects, bots } satisfies BotEgressPoliciesResponse);
  });

  router.put("/myrmidon/companies/:companyId/bot-egress/projects/:projectId", async (req, res) => {
    assertBoard(req);
    const companyId = companyIdOf(req);
    const projectId = req.params.projectId as string;
    if (!UUID_PATTERN.test(projectId)) throw notFound("Project not found");
    if (!(await deps.store.hasProject(companyId, projectId))) throw notFound("Project not found");

    let policy: { mode: EgressProjectMode; verified: boolean; allow: string[] };
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      policy = {
        mode: readModeInput(body.mode),
        verified: body.verified === true,
        allow: readAllowInput(body.allow),
      };
    } catch (err) {
      throw badRequest(err instanceof Error ? err.message : "invalid egress policy");
    }
    // The plan's risk note, as a rule: no blocking before the list was compared
    // with the observation journal.
    const refusal = projectPolicySaveRefusal({ mode: policy.mode, verified: policy.verified, allow: parseEgressAllowlistInput(policy.allow) });
    if (refusal !== null) throw conflict(refusal, { code: "bot_egress_block_needs_verified_list" });

    await deps.store.upsertProject(companyId, projectId, policy);
    const names = await deps.store.projectNames(companyId);
    const saved = projectView(projectId, names.get(projectId) ?? "", { scope: "project", targetId: projectId, mode: policy.mode, verified: policy.verified, allow: policy.allow, project: null });
    res.json({ project: saved });
  });

  router.put("/myrmidon/companies/:companyId/bot-egress/bots/:botKey", async (req, res) => {
    assertBoard(req);
    const companyId = companyIdOf(req);
    const botKey = req.params.botKey as string;
    if (!TARGET_ID_PATTERN.test(botKey)) throw notFound("Bot not found");

    let policy: { project: string; allow: string[] };
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const project = body.project === undefined || body.project === null ? "" : body.project;
      if (typeof project !== "string") throw new EgressPolicyInputError("project must be a string");
      policy = { project: project.trim(), allow: readAllowInput(body.allow) };
    } catch (err) {
      throw badRequest(err instanceof Error ? err.message : "invalid egress policy");
    }

    await deps.store.upsertBot(companyId, botKey, policy);
    res.json({ bot: { botKey, project: policy.project, allow: policy.allow } satisfies BotEgressView });
  });

  router.get("/myrmidon/companies/:companyId/bot-egress/refusals", async (req, res) => {
    assertBoard(req);
    companyIdOf(req);
    try {
      res.json({ refusals: await deps.readRefusals() });
    } catch (err) {
      logger.warn({ err }, "bot egress refusal feed is unavailable");
      // Answered directly, not thrown: the shared error handler reports every
      // thrown 5xx as a crash, and an unreachable proxy is a configuration
      // state, not a fault of the board.
      res.status(503).json({
        error: "The egress proxy did not answer; the refusal feed is unavailable.",
        code: "bot_egress_refusals_unavailable",
      });
    }
  });

  /** The document the proxy fetches. Token, not board auth: the caller is a service. */
  router.get("/myrmidon/bot-egress/policy", async (req, res) => {
    const token = envNow()[BOT_EGRESS_TOKEN_ENV]?.trim();
    if (!token) {
      res.status(503).json({
        error: `Bot egress policies are not published on this instance (${BOT_EGRESS_TOKEN_ENV} is not set)`,
        code: "bot_egress_policy_not_published",
      });
      return;
    }
    const header = req.headers.authorization ?? "";
    const presented = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
    if (presented.length === 0 || presented !== token) {
      throw unauthorized("The egress policy endpoint needs the instance token");
    }
    const rows = await deps.store.listAll();
    res.json(buildEgressPolicyDocument(rows));
  });

  return router;
}