import { describe, expect, it } from "vitest";

import { fleetRoutingDriver, type FleetRoutingDeps, type RoutedBotAgent } from "./fleetd-routing.js";
import type { BotContainerDriver, BotContainerSpec, BotContainerStatus } from "./driver.js";
import type { CompiledProfile } from "./types.js";

// Everything here is placeholder data: fake bot keys and statuses.

const spec = (botKey: string): BotContainerSpec => ({
  botKey,
  image: "example.com/bot@sha256:aa",
  memoryMb: 1024,
  cpus: 1,
  pidsLimit: 256,
  network: "net-a",
});

const profile: CompiledProfile = {
  botKey: "bot-a",
  files: [{ path: "hermes/config.yaml", content: "gateway: {}\n", mode: 0o644, secret: false }],
  restartHash: "r1",
  filesHash: "f1",
};

/** A driver that records every call and answers with a fixed status. */
function recordingDriver(name: string): BotContainerDriver & { calls: string[] } {
  const calls: string[] = [];
  const status: BotContainerStatus = { botKey: "bot-a", state: "running" };
  const driver: BotContainerDriver = {
    async status(botKey) {
      calls.push(`${name}:status:${botKey}`);
      return { ...status, botKey };
    },
    async list() {
      calls.push(`${name}:list`);
      return [status];
    },
    async templateDrift(s) {
      calls.push(`${name}:templateDrift:${s.botKey}`);
      return false;
    },
    async create(s) {
      calls.push(`${name}:create:${s.botKey}`);
    },
    async recreate(s) {
      calls.push(`${name}:recreate:${s.botKey}`);
    },
    async writeProfile(botKey, p) {
      calls.push(`${name}:writeProfile:${botKey}:${p.restartHash}`);
    },
    async start(botKey) {
      calls.push(`${name}:start:${botKey}`);
    },
    async restart(botKey) {
      calls.push(`${name}:restart:${botKey}`);
    },
    async stop(botKey) {
      calls.push(`${name}:stop:${botKey}`);
    },
  };
  return Object.assign(driver, { calls });
}

function deps(): FleetRoutingDeps & { local: ReturnType<typeof recordingDriver>; fleetA: ReturnType<typeof recordingDriver> } {
  const local = recordingDriver("local");
  const fleetA = recordingDriver("fleet-a");
  return { local, fleetA, fleet: new Map([["host-a", fleetA]]) };
}

const agent = (host: string | null): RoutedBotAgent =>
  host === null ? { adapterConfig: {} } : { adapterConfig: { container: { host } } };

describe("myrmidon(FLEETD-VMEXEC) fleet routing — every driver call goes by the card's host", () => {
  it("routes to the local driver when the card names no host", async () => {
    const d = deps();
    const routed = fleetRoutingDriver(d, () => agent(null));
    await routed.start("bot-a");
    await routed.stop("bot-a");
    expect(d.local.calls).toEqual(["local:start:bot-a", "local:stop:bot-a"]);
    expect(d.fleetA.calls).toEqual([]);
  });

  it("routes to the named host's client", async () => {
    const d = deps();
    const routed = fleetRoutingDriver(d, () => agent("host-a"));
    await routed.create(spec("bot-a"));
    await routed.writeProfile("bot-a", profile);
    await routed.restart("bot-a");
    expect(d.fleetA.calls).toEqual([
      "fleet-a:create:bot-a",
      "fleet-a:writeProfile:bot-a:r1",
      "fleet-a:restart:bot-a",
    ]);
    expect(d.local.calls).toEqual([]);
  });

  it("status and templateDrift route the same way", async () => {
    const d = deps();
    const agents = new Map<string, RoutedBotAgent>([
      ["bot-local", agent(null)],
      ["bot-fleet", agent("host-a")],
    ]);
    const routed = fleetRoutingDriver(d, (botKey) => agents.get(botKey));
    expect((await routed.status("bot-local")).state).toBe("running");
    expect((await routed.status("bot-fleet")).state).toBe("running");
    await routed.templateDrift(spec("bot-fleet"));
    expect(d.local.calls).toEqual(["local:status:bot-local"]);
    expect(d.fleetA.calls).toEqual(["fleet-a:status:bot-fleet", "fleet-a:templateDrift:bot-fleet"]);
  });

  it("an unknown agent record routes to the local driver (a missing card cannot strand a bot)", async () => {
    const d = deps();
    const routed = fleetRoutingDriver(d, () => undefined);
    await routed.start("bot-a");
    expect(d.local.calls).toEqual(["local:start:bot-a"]);
  });

  it("a card naming a host that is not configured is an error, never a local fallback", async () => {
    const d = deps();
    const routed = fleetRoutingDriver(d, () => agent("host-b"));
    await expect(routed.start("bot-a")).rejects.toThrow(/names no configured fleet host/);
    expect(d.local.calls).toEqual([]);
    expect(d.fleetA.calls).toEqual([]);
  });

  it("list is the union over the local driver and every fleet host", async () => {
    const d = deps();
    const routed = fleetRoutingDriver(d, () => agent(null));
    const bots = await routed.list();
    expect(bots).toHaveLength(2);
    expect(d.local.calls).toEqual(["local:list"]);
    expect(d.fleetA.calls).toEqual(["fleet-a:list"]);
  });
});
