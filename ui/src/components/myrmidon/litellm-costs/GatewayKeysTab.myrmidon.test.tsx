// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { countKeyedAgents } from "./litellmKeysApi";
import { cycleLines, keyRows } from "./GatewayKeysTab";
import type { AgentGatewayKeyView } from "./litellmKeysApi";

const view = (over: Partial<AgentGatewayKeyView>): AgentGatewayKeyView => ({
  agentId: "agent-a",
  secretName: "llm-gateway-key-agent-a",
  present: false,
  valueHash: null,
  canManageKeys: true,
  ...over,
});

describe("myrmidon(M2-B) gateway keys tab", () => {
  it("joins key state with agent names and sorts by name", () => {
    const rows = keyRows(
      [
        view({ agentId: "agent-b", secretName: "llm-gateway-key-beta-agent-b" }),
        view({ agentId: "agent-a", secretName: "llm-gateway-key-alpha-agent-a", present: true }),
      ],
      new Map([
        ["agent-a", "alpha"],
        ["agent-b", "beta"],
      ]),
    );
    expect(rows.map((row) => row.agentName)).toEqual(["alpha", "beta"]);
    expect(rows[0]!.present).toBe(true);
  });

  it("counts how many agents have a key of their own", () => {
    expect(countKeyedAgents([view({ present: true }), view({ agentId: "b" })])).toEqual({ keyed: 1, total: 2 });
  });

  it("shows no loop lines while the gateway could not be read", () => {
    expect(cycleLines({ chains: [], cycles: [], error: "the gateway answered 500" })).toEqual([]);
    expect(cycleLines(undefined)).toEqual([]);
  });

  it("names each loop it found", () => {
    expect(
      cycleLines({
        chains: [],
        cycles: [
          { path: ["model-a", "model-b"], described: "model-a -> model-b -> model-a" },
        ],
      }),
    ).toEqual(["model-a -> model-b -> model-a"]);
  });
});