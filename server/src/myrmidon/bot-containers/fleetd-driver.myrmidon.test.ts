import http from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  FleetdDriverError,
  fleetdBotContainerDriver,
  readFleetdDriverConfig,
  type FleetdDriverConfig,
  type FleetdDriverOptions,
} from "./fleetd-driver.js";
import type { CompiledProfile } from "./types.js";

// Everything here is placeholder data: fake ids, names and values.

const CONFIG: FleetdDriverConfig = { baseUrl: "http://127.0.0.1:0", token: "fake-fleetd-token" };

const profile: CompiledProfile = {
  botKey: "bot-a",
  files: [
    { path: "hermes/config.yaml", content: "gateway: {}\n", mode: 0o644, secret: false },
    { path: "hermes/.env", content: 'API_SERVER_KEY="fake-key"\n', mode: 0o600, secret: true },
  ],
  restartHash: "r1",
  filesHash: "f1",
};

interface CapturedCall {
  method: string;
  path: string;
  body: unknown;
  headers: Record<string, string | string[] | undefined>;
}

function fakeServer(
  handler: (call: CapturedCall, res: http.ServerResponse) => void,
): Promise<{ server: http.Server; calls: CapturedCall[]; config: FleetdDriverConfig }> {
  const calls: CapturedCall[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const call: CapturedCall = {
        method: req.method ?? "",
        path: req.url ?? "",
        body: raw.length === 0 ? undefined : JSON.parse(raw),
        headers: req.headers,
      };
      calls.push(call);
      handler(call, res);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("expected a tcp address");
      resolve({ server, calls, config: { baseUrl: `http://127.0.0.1:${address.port}`, token: CONFIG.token } });
    });
  });
}

describe("myrmidon(FLEETD-VMEXEC) fleetd driver — the HTTP contract", () => {
  it("status maps the fleetd answer as-is", async () => {
    const { server, config } = await fakeServer((_call, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ botKey: "bot-a", state: "running", image: "example.com/bot@sha256:aa", restartHash: "r1", filesHash: "f1" }));
    });
    try {
      const driver = fleetdBotContainerDriver(config);
      const status = await driver.status("bot-a");
      expect(status).toEqual({
        botKey: "bot-a",
        state: "running",
        image: "example.com/bot@sha256:aa",
        restartHash: "r1",
        filesHash: "f1",
      });
    } finally {
      server.close();
    }
  });

  it("list accepts both a bare array and { bots: [...] }", async () => {
    for (const body of [
      [{ botKey: "bot-a", state: "stopped" }],
      { bots: [{ botKey: "bot-a", state: "stopped" }] },
    ]) {
      const { server, config } = await fakeServer((_call, res) => {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(body));
      });
      try {
        const driver = fleetdBotContainerDriver(config);
        expect(await driver.list()).toEqual([{ botKey: "bot-a", state: "stopped" }]);
      } finally {
        server.close();
      }
    }
  });

  it("sends the spec for templateDrift/create/recreate and returns the drift flag", async () => {
    const { server, config, calls } = await fakeServer((call, res) => {
      res.setHeader("Content-Type", "application/json");
      if (call.path === "/v1/bots/bot-a/template-drift") res.end(JSON.stringify({ drift: true }));
      else res.end("{}");
    });
    try {
      const driver = fleetdBotContainerDriver(config);
      const spec = { botKey: "bot-a", image: "example.com/bot@sha256:aa", memoryMb: 1024, cpus: 1, pidsLimit: 256, network: "net-a" };
      expect(await driver.templateDrift(spec)).toBe(true);
      await driver.create(spec);
      await driver.recreate(spec);
      expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
        "POST /v1/bots/bot-a/template-drift",
        "POST /v1/bots",
        "POST /v1/bots/bot-a/recreate",
      ]);
      for (const call of calls) expect(call.body).toEqual({ spec });
    } finally {
      server.close();
    }
  });

  it("writeProfile PUTs the whole profile as JSON", async () => {
    const { server, config, calls } = await fakeServer((_call, res) => res.end("{}"));
    try {
      const driver = fleetdBotContainerDriver(config);
      await driver.writeProfile("bot-a", profile);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.method).toBe("PUT");
      expect(calls[0]!.path).toBe("/v1/bots/bot-a/profile");
      expect(calls[0]!.body).toEqual({ profile });
    } finally {
      server.close();
    }
  });

  it("start/restart/stop POST to their routes", async () => {
    const { server, config, calls } = await fakeServer((_call, res) => res.end("{}"));
    try {
      const driver = fleetdBotContainerDriver(config);
      await driver.start("bot-a");
      await driver.restart("bot-a");
      await driver.stop("bot-a");
      expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
        "POST /v1/bots/bot-a/start",
        "POST /v1/bots/bot-a/restart",
        "POST /v1/bots/bot-a/stop",
      ]);
    } finally {
      server.close();
    }
  });
});

describe("myrmidon(FLEETD-VMEXEC) fleetd driver — auth and errors", () => {
  it("sends the bearer token on every call and never logs it", async () => {
    const { server, config, calls } = await fakeServer((_call, res) => res.end("{}"));
    try {
      const driver = fleetdBotContainerDriver(config);
      await driver.status("bot-a");
      expect(calls[0]!.headers.authorization).toBe(`Bearer ${CONFIG.token}`);
    } finally {
      server.close();
    }
  });

  it("a non-2xx answer is a FleetdDriverError with status and one-line reason", async () => {
    const { server, config } = await fakeServer((_call, res) => {
      res.statusCode = 403;
      res.end("bot_not_enrolled");
    });
    try {
      const driver = fleetdBotContainerDriver(config);
      await expect(driver.status("bot-a")).rejects.toBeInstanceOf(FleetdDriverError);
      await expect(driver.status("bot-a")).rejects.toThrow("fleetd 403 bot_not_enrolled");
    } finally {
      server.close();
    }
  });

  it("an error body is never echoed beyond one short line", async () => {
    const { server, config } = await fakeServer((_call, res) => {
      res.statusCode = 500;
      res.end("x".repeat(500));
    });
    try {
      const driver = fleetdBotContainerDriver(config);
      const err: unknown = await driver.status("bot-a").then(
        () => { throw new Error("expected a failure"); },
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(FleetdDriverError);
      expect(String((err as FleetdDriverError).message).length).toBeLessThan(220);
    } finally {
      server.close();
    }
  });

  it("readFleetdDriverConfig requires both URL and token", () => {
    expect(() => readFleetdDriverConfig({})).toThrow(/MYRMIDON_FLEET_HOST_URL/);
    expect(() => readFleetdDriverConfig({ MYRMIDON_FLEET_HOST_URL: "http://fleetd.example.com" })).toThrow(
      /MYRMIDON_FLEET_HOST_TOKEN/,
    );
    const config = readFleetdDriverConfig({
      MYRMIDON_FLEET_HOST_URL: "http://fleetd.example.com/",
      MYRMIDON_FLEET_HOST_TOKEN: " fake-token ",
    });
    expect(config.baseUrl).toBe("http://fleetd.example.com");
    expect(config.token).toBe("fake-token");
  });
});

describe("myrmidon(FLEETD-VMEXEC) fleetd driver — request injection hooks", () => {
  function driverWith(
    responses: RawResponse[],
  ): { driver: ReturnType<typeof fleetdBotContainerDriver>; calls: unknown[] } {
    const calls: unknown[] = [];
    const responsesLeft = [...responses];
    const options: FleetdDriverOptions = {
      request: async (opts) => {
        calls.push(opts);
        const next = responsesLeft.shift();
        if (!next) throw new Error("no response left");
        return next;
      },
    };
    return { driver: fleetdBotContainerDriver(CONFIG, options), calls };
  }

  it("uses the injected transport, sends JSON bodies with the auth header", async () => {
    const { driver, calls } = driverWith([{ status: 200, body: Buffer.from("{}", "utf8") }]);
    await driver.create({
      botKey: "bot-a",
      image: "example.com/bot@sha256:aa",
      memoryMb: 1024,
      cpus: 1,
      pidsLimit: 256,
      network: "net-a",
    });
    const call = calls[0] as { method: string; path: string; body: Buffer; headers: Record<string, string> };
    expect(call.method).toBe("POST");
    // the injected transport receives the path WITHOUT the /v1 prefix: the real
    // transport adds it (fleetdRequest); the assertion matches that seam.
    expect(call.path).toBe("/bots");
    expect(JSON.parse(call.body.toString("utf8"))).toEqual({
      spec: { botKey: "bot-a", image: "example.com/bot@sha256:aa", memoryMb: 1024, cpus: 1, pidsLimit: 256, network: "net-a" },
    });
    expect(call.headers.authorization).toBe(`Bearer ${CONFIG.token}`);
    expect(call.headers["Content-Type"]).toBe("application/json");
  });

  it("rejects on a transport error (connection refused class)", async () => {
    const { driver } = driverWith([]);
    await expect(driver.status("bot-a")).rejects.toThrow(/no response left/);
  });

  it("parseFleetdEndpoint accepts http host:port and rejects anything else", async () => {
    const { parseFleetdEndpoint } = await import("./fleetd-driver.js");
    expect(parseFleetdEndpoint("http://fleetd.example.com")).toEqual({ host: "fleetd.example.com", port: 80 });
    expect(parseFleetdEndpoint("http://fleetd.example.com:9100")).toEqual({ host: "fleetd.example.com", port: 9100 });
    expect(() => parseFleetdEndpoint("https://fleetd.example.com")).toThrow(/must be http/);
    expect(() => parseFleetdEndpoint("http://fleetd.example.com:notaport")).toThrow();
  });
});

interface RawResponse {
  status: number;
  body: Buffer;
}
