/**
 * Myrmidon (P9): which assigned MCP connections go into a run.
 *
 * Vendor behaviour: a connection whose health "needs attention" (a failed probe
 * or call) was dropped from the run's MCP set, so one unhealthy connection
 * disappeared from the run entirely. Here health is not a filter: a connection
 * assigned to the agent stays in the run whatever its last probe said, and a
 * failing call is reported for that one tool by the gateway. Only disabled or
 * inactive connections are left out (and reported as unavailable).
 *
 * Both the heartbeat (dispatch) and the native runtime context (run start) use
 * these predicates: native runs compare the assignment digests of both sides.
 */

const RUN_MCP_TRANSPORTS = new Set(["mcp_remote", "local_stdio"]);

type RunConnection = { enabled?: boolean | null; status?: string | null; transport?: string | null };

/** An assigned connection that goes into the run's MCP set. */
export function isRunSelectableConnection(connection: RunConnection): boolean {
  return connection.status === "active" && connection.enabled === true && RUN_MCP_TRANSPORTS.has(connection.transport ?? "");
}

/** An assigned MCP connection that is left out of the run and reported. */
export function isRunUnavailableConnection(connection: RunConnection): boolean {
  return RUN_MCP_TRANSPORTS.has(connection.transport ?? "") && (!connection.enabled || connection.status !== "active");
}
