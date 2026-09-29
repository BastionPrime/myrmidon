// server/src/myrmidon/bot-containers/agents-query.ts
//
// myrmidon(W2a): the agents-table query behind the periodic reconciliation sweep
// (startup.ts hands it to startBotContainerReconciliation as `listAgents`).
//
// The filter runs in the database: only `hermes_gateway` agents whose card has
// `adapterConfig.container.enabled` set to true, and never a terminated one.
// (The board hard-deletes an agent row; there is no soft-delete column, so a
// deleted agent is simply absent.) The sweep runs once a minute, so the query
// reads only the `container` sub-object of the card, not the whole adapterConfig
// (which can carry a long instructions text and env bindings): reconcile needs
// nothing else, and everything else about the bot is read by the profile
// compiler by agent id. `container.enabled` is compared as the JSON text `true`,
// so a string "true" or a number does not qualify, exactly like
// readBotContainerAgentConfig, which the sweep applies to each row afterwards.

import { agents, type Db } from "@paperclipai/db";
import { and, eq, ne, sql } from "drizzle-orm";
import type { BotContainerAgent } from "./index.js";

export const HERMES_GATEWAY_ADAPTER_TYPE = "hermes_gateway";

/** Agents the sweep reconciles; see the module comment. */
export function listBotContainerAgents(db: Db): () => Promise<BotContainerAgent[]> {
  return async () => {
    const rows = await db
      .select({
        agentId: agents.id,
        adapterType: agents.adapterType,
        // jsonb `->`; decoded through the column's own decoder, which parses the
        // text form some drivers return for a jsonb expression.
        container: sql<unknown>`${agents.adapterConfig} -> 'container'`.mapWith(agents.adapterConfig),
      })
      .from(agents)
      .where(
        and(
          eq(agents.adapterType, HERMES_GATEWAY_ADAPTER_TYPE),
          ne(agents.status, "terminated"),
          sql`${agents.adapterConfig} #>> '{container,enabled}' = 'true'`,
        ),
      );
    return rows.map((row) => ({
      agentId: row.agentId,
      adapterType: row.adapterType,
      adapterConfig: { container: row.container },
    }));
  };
}
