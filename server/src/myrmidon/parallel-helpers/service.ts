// Read and change the parallel-helper ceiling and default without a restart
// (myrmidon PARALLEL-HELPERS).
//
// Contract: `instance_settings.general.parallelHelpers` is the source of truth
// once an operator saves it; the module defaults apply for an instance that
// never did (see packages/shared/src/myrmidon-parallel-helpers.ts). A change
// writes the row and records it in the activity log for every company. Nothing
// has to be applied to a live object: the profile compiler re-reads the row on
// every reconcile tick, so every bot's config.yaml picks the new ceiling up
// within one tick without a restart.
//
// The capacity hint (sum of the per-agent helper limits vs the build slots and
// host memory) is computed from the agents' stored cards, read-only, and is a
// warning in the view — never a block on the write.
//
// Two overlapping writes can commit their rows in one order and audit them in
// the other; the audit would then disagree with the stored value. Every write
// runs through one queue, exactly as the runtime limits transition does.

import type { Db } from "@paperclipai/db";
import {
  helperCapacityHint,
  helpersCeiling,
  helpersDefault,
  resolveParallelHelpers,
  type HelperCapacityHint,
  type ParallelHelpersSettings,
} from "@paperclipai/shared";
import { logger } from "../../middleware/logger.js";
import { instanceSettingsService, logActivity } from "../../services/index.js";

/** What the GET view reports, beside the settings themselves. */
export interface ParallelHelpersView {
  settings: ParallelHelpersSettings;
  /** Defaults the module applies when a field is unset (shown, not stored). */
  effective: {
    ceiling: number;
    defaultPerAgent: number;
  };
  capacity: HelperCapacityHint;
}

export interface ParallelHelpersActor {
  actorType: "agent" | "user" | "system" | "plugin";
  actorId: string;
  agentId: string | null;
  runId: string | null;
  agentApiKeyId: string | null;
}

export type ParallelHelpersAuditEntry = ParallelHelpersActor & {
  companyId: string;
  action: string;
  entityType: string;
  entityId: string;
  details: Record<string, unknown>;
};

export interface ParallelHelpersServiceDeps {
  settings: {
    getGeneral(): Promise<{ parallelHelpers?: unknown }>;
    updateGeneral(patch: { parallelHelpers: ParallelHelpersSettings }): Promise<unknown>;
  };
  listCompanyIds(): Promise<string[]>;
  logActivity(entry: ParallelHelpersAuditEntry): Promise<unknown>;
  /** The agents whose cards the capacity hint sums. Read-only. */
  listCards(): Promise<Array<{ id: string; name: string; adapterConfig: Record<string, unknown> }>>;
}

export interface ParallelHelpersService {
  read(): Promise<ParallelHelpersView>;
  update(patch: Partial<ParallelHelpersSettings>, actor: ParallelHelpersActor): Promise<ParallelHelpersView>;
}

/** `instance.parallel_helpers.updated` — the audit action of a change. */
export const PARALLEL_HELPERS_ACTION = "instance.parallel_helpers.updated";

let parallelHelpersTransitionQueue: Promise<void> = Promise.resolve();

function withParallelHelpersTransition<T>(run: () => Promise<T>): Promise<T> {
  const turn = parallelHelpersTransitionQueue.then(run);
  parallelHelpersTransitionQueue = turn.then(
    () => undefined,
    () => undefined,
  );
  return turn;
}

export function parallelHelpersService(
  db: Db,
  overrides: Partial<ParallelHelpersServiceDeps> = {},
): ParallelHelpersService {
  const deps: ParallelHelpersServiceDeps = {
    settings: instanceSettingsService(db),
    listCompanyIds: () => instanceSettingsService(db).listCompanyIds(),
    logActivity: (entry) => logActivity(db, entry),
    // The capacity hint is instance-level but the agents are company-scoped;
    // the wiring (index.ts) supplies the cross-company walk.
    listCards: async () => [],
    ...overrides,
  };

  async function view(settings: ParallelHelpersSettings): Promise<ParallelHelpersView> {
    const cards = await deps.listCards();
    const agents = cards.map((agent) => {
      // The same resolution the profile compiler applies, so the hint counts
      // what a bot would actually run with, not what the raw card says.
      const resolved = resolveParallelHelpers(agent.adapterConfig, settings);
      return { enabled: resolved.enabled, maxConcurrent: resolved.maxConcurrent };
    });
    return {
      settings,
      // HELPERS-NO-CAP: the effective values come from the shared resolver,
      // which takes the owner's ceiling as written — no hard cap above it.
      effective: {
        ceiling: helpersCeiling(settings),
        defaultPerAgent: helpersDefault(settings),
      },
      capacity: helperCapacityHint(agents, settings),
    };
  }

  return {
    read: async () => {
      const general = await deps.settings.getGeneral();
      const stored = (general.parallelHelpers ?? {}) as ParallelHelpersSettings;
      return view(stored);
    },

    update: async (patch, actor) =>
      withParallelHelpersTransition(async () => {
        const general = await deps.settings.getGeneral();
        const before = (general.parallelHelpers ?? {}) as ParallelHelpersSettings;
        // Merge, then let the validator's constraints be the only coercion: a
        // partial PATCH (e.g. only the ceiling) keeps the other fields.
        const next: ParallelHelpersSettings = { ...before, ...patch };
        const changedKeys = (Object.keys(next) as Array<keyof ParallelHelpersSettings>).filter(
          (key) => before[key] !== next[key],
        );

        await deps.settings.updateGeneral({ parallelHelpers: next });

        const companyIds = await deps.listCompanyIds();
        await Promise.all(
          companyIds.map((companyId) =>
            deps.logActivity({
              companyId,
              actorType: actor.actorType,
              actorId: actor.actorId,
              agentId: actor.agentId,
              runId: actor.runId,
              agentApiKeyId: actor.agentApiKeyId,
              action: PARALLEL_HELPERS_ACTION,
              entityType: "instance_settings",
              entityId: "default",
              details: { previous: before, next, changedKeys },
            }),
          ),
        );

        logger.info(
          { parallelHelpers: next, changedKeys, actorType: actor.actorType },
          "parallel helper ceiling updated without a restart",
        );
        return view(next);
      }),
  };
}
