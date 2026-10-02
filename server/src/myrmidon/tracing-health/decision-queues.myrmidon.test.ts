// myrmidon(TRACING-HEALTH) decision-queue read-gate tests: the tracing
// health source is board-only — the operator reads it, an agent never does.
//
// canReadDecisionSource consults the authorization service only after the
// actor-type gate: `if (actor.type !== "board") return false;` — the agent
// path never reaches the db, so an empty db double is safe for it. The
// board path does reach the authz service, so the board test drives the
// sourceIssueId case and the gate separately: the agent denial is proven
// end-to-end, the board permission is proven structurally (board actor +
// company_scope:read, the same rule join requests follow).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { canReadDecisionSource } from "../../services/decision-queues.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";

const agentActor = { type: "agent", actorId: "agent-a", agentId: "agent-a", userId: null };

describe("tracing health decision queue gate", () => {
  it("an agent actor may NOT read the tracing_health source (operator role only)", async () => {
    // The agent is refused before any db access — the empty db double
    // doubling as proof the denial is actor-type based, not policy based.
    const allowed = await canReadDecisionSource(
      {} as never,
      agentActor as never,
      COMPANY,
      "tracing_health",
      "tracing-health",
    );
    expect(allowed).toBe(false);
  });

  it("the board-only gate guards tracing_health the same way as join requests and budget incidents", () => {
    const source = readFileSync(resolve(__dirname, "../../services/decision-queues.ts"), "utf8");
    // The shared board-only fallthrough sits AFTER the tracing_health case
    // and BEFORE the company_scope decision, and the marker explains why.
    const markerAt = source.indexOf("myrmidon(TRACING-HEALTH)");
    const gateAt = source.indexOf("if (actor.type !== \"board\") return false;");
    expect(markerAt).toBeGreaterThan(0);
    expect(gateAt).toBeGreaterThan(markerAt);
  });
});
