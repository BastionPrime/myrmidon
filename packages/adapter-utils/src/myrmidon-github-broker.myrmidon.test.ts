import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import vm from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { githubBrokerEnvironment, githubLauncherSource } from "./github-launcher.js";
import {
  GITHUB_BROKER_MAX_CANDIDATES,
  GITHUB_BROKER_REQUEST_TIMEOUT_MS,
  GITHUB_BROKER_TOTAL_TIMEOUT_MS,
  githubBrokerCandidatesLauncherSource,
} from "./myrmidon-github-broker.js";

const exec = promisify(execFile);
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

type FakeResponse = { status: number; ok: boolean; arrayBuffer: () => Promise<ArrayBuffer>; json: () => Promise<unknown> };
type FetchCall = { url: string; timeoutMs: number | null; headers: Record<string, string> };
type Walk = {
  paperclipBrokerCandidateUrls: (env: Record<string, string | undefined>) => string[];
  paperclipRequestBrokerCredentials: (
    env: Record<string, string | undefined>,
    urls: string[],
    limits?: { requestTimeoutMs?: number; totalTimeoutMs?: number; retryDelayMs?: number },
  ) => Promise<{ response: FakeResponse | null; tried: string[] }>;
};

function response(status: number): FakeResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    arrayBuffer: async () => new ArrayBuffer(0),
    json: async () => ({ status: "available", env: {} }),
  };
}

/** Load the launcher snippet with a scripted fetch; returns the snippet's functions. */
function loadWalk(handler: (call: FetchCall) => Promise<FakeResponse>) {
  const calls: FetchCall[] = [];
  const fakeFetch = async (url: string, init: { signal?: AbortSignal & { __timeoutMs?: number }; headers: Record<string, string> }) => {
    const call = { url, timeoutMs: init.signal?.__timeoutMs ?? null, headers: init.headers };
    calls.push(call);
    return handler(call);
  };
  const FakeAbortSignal = {
    timeout: (ms: number) => ({ __timeoutMs: ms }),
  };
  const context = vm.createContext({ fetch: fakeFetch, AbortSignal: FakeAbortSignal, setTimeout, Date, JSON, Math, Set, Array, String, Promise });
  const walk = vm.runInContext(
    `${githubBrokerCandidatesLauncherSource()}\n({ paperclipBrokerCandidateUrls, paperclipRequestBrokerCredentials })`,
    context,
  ) as Walk;
  return { walk, calls };
}

const BASE_ENV = {
  PAPERCLIP_GITHUB_BROKER_TOKEN: "broker-capability-value",
  PAPERCLIP_GITHUB_BRIDGE_TOKEN: "bridge-token-value",
};

describe("GitHub broker candidate list (myrmidon P6)", () => {
  it("orders candidates broker URL, API URL, runtime API URL, then runtime candidates", () => {
    const { walk } = loadWalk(async () => response(200));
    expect(
      walk.paperclipBrokerCandidateUrls({
        PAPERCLIP_GITHUB_BROKER_URL: "https://board.example.com:8443/",
        PAPERCLIP_API_URL: "https://agent-entry.example.com/api",
        PAPERCLIP_RUNTIME_API_URL: "http://127.0.0.1:3100",
        PAPERCLIP_RUNTIME_API_CANDIDATES_JSON: JSON.stringify(["http://198.51.100.20:3100"]),
      }),
    ).toEqual([
      "https://board.example.com:8443",
      "https://agent-entry.example.com",
      "http://127.0.0.1:3100",
      "http://198.51.100.20:3100",
    ]);
  });

  it("drops duplicates and caps the list at six", () => {
    const { walk } = loadWalk(async () => response(200));
    const urls = walk.paperclipBrokerCandidateUrls({
      PAPERCLIP_GITHUB_BROKER_URL: "http://127.0.0.1:3100",
      PAPERCLIP_API_URL: "http://127.0.0.1:3100/",
      PAPERCLIP_RUNTIME_API_URL: "http://127.0.0.1:3100/api",
      PAPERCLIP_RUNTIME_API_CANDIDATES_JSON: JSON.stringify(
        Array.from({ length: 10 }, (_, index) => `http://198.51.100.${index + 1}:3100`),
      ),
    });
    expect(GITHUB_BROKER_MAX_CANDIDATES).toBe(6);
    expect(urls).toHaveLength(6);
    expect(urls[0]).toBe("http://127.0.0.1:3100");
    expect(new Set(urls).size).toBe(6);
    expect(urls.at(-1)).toBe("http://198.51.100.5:3100");
  });

  it("ignores malformed runtime candidate JSON and non-string items", () => {
    const { walk } = loadWalk(async () => response(200));
    expect(
      walk.paperclipBrokerCandidateUrls({ PAPERCLIP_API_URL: "http://127.0.0.1:3100", PAPERCLIP_RUNTIME_API_CANDIDATES_JSON: "{" }),
    ).toEqual(["http://127.0.0.1:3100"]);
    expect(
      walk.paperclipBrokerCandidateUrls({ PAPERCLIP_RUNTIME_API_CANDIDATES_JSON: JSON.stringify([42, null, " http://127.0.0.1:3100 "]) }),
    ).toEqual(["http://127.0.0.1:3100"]);
  });
});

describe("GitHub broker candidate walk (myrmidon P6)", () => {
  const urls = ["https://board.example.com:8443", "http://127.0.0.1:3100", "http://198.51.100.20:3100"];

  it("keeps walking after a transport failure and an HTTP error", async () => {
    const { walk, calls } = loadWalk(async (call) => {
      if (call.url.startsWith("https://board.example.com")) throw new TypeError("fetch failed");
      if (call.url.startsWith("http://127.0.0.1")) return response(400);
      return response(200);
    });
    const result = await walk.paperclipRequestBrokerCredentials(BASE_ENV, urls);
    expect(result.response?.status).toBe(200);
    expect(calls.map((call) => call.url)).toEqual(urls.map((url) => `${url}/runtime-tools/github/credentials`));
    expect(result.tried).toEqual([
      "https://board.example.com:8443/runtime-tools/github/credentials -> no_response",
      "http://127.0.0.1:3100/runtime-tools/github/credentials -> 400",
    ]);
  });

  it("stops at the first candidate that answers ok", async () => {
    const { walk, calls } = loadWalk(async () => response(200));
    const result = await walk.paperclipRequestBrokerCredentials(BASE_ENV, urls);
    expect(result.response?.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(result.tried).toEqual([]);
  });

  it("retries 409 on the same candidate before moving on", async () => {
    let conflicts = 2;
    const { walk, calls } = loadWalk(async () => response(conflicts-- > 0 ? 409 : 200));
    const result = await walk.paperclipRequestBrokerCredentials(BASE_ENV, urls, { retryDelayMs: 1 });
    expect(result.response?.status).toBe(200);
    expect(calls.map((call) => call.url)).toEqual(Array(3).fill(`${urls[0]}/runtime-tools/github/credentials`));
  });

  it("bounds each request at 10 s and the whole walk at 60 s by default", async () => {
    expect(GITHUB_BROKER_REQUEST_TIMEOUT_MS).toBe(10_000);
    expect(GITHUB_BROKER_TOTAL_TIMEOUT_MS).toBe(60_000);
    const { walk, calls } = loadWalk(async () => {
      throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
    });
    const result = await walk.paperclipRequestBrokerCredentials(BASE_ENV, urls);
    expect(result.response).toBeNull();
    for (const call of calls) {
      expect(call.timeoutMs).toBeGreaterThan(0);
      expect(call.timeoutMs).toBeLessThanOrEqual(10_000);
    }
    expect(result.tried.every((entry) => entry.endsWith("-> timeout"))).toBe(true);
  });

  it("gives later requests only the time left in the overall budget", async () => {
    const { walk, calls } = loadWalk(
      (call) =>
        new Promise((resolve) => {
          setTimeout(() => resolve(response(503)), Math.min(call.timeoutMs ?? 0, 60));
        }),
    );
    const result = await walk.paperclipRequestBrokerCredentials(BASE_ENV, urls, {
      requestTimeoutMs: 60,
      totalTimeoutMs: 100,
    });
    expect(result.response?.status).toBe(503);
    expect(calls[0]?.timeoutMs).toBe(60);
    expect(calls[1]?.timeoutMs).toBeLessThan(60);
    // The third candidate is never tried: the overall budget ran out.
    expect(calls.length).toBeLessThan(urls.length);
  });

  it("sends the capability headers but never reports tokens in diagnostics", async () => {
    const { walk, calls } = loadWalk(async () => response(403));
    const result = await walk.paperclipRequestBrokerCredentials(BASE_ENV, urls);
    expect(calls[0]?.headers.authorization).toBe("Bearer bridge-token-value");
    expect(calls[0]?.headers["x-paperclip-github-capability"]).toBe("broker-capability-value");
    expect(result.response?.status).toBe(403);
    expect(result.tried.join("\n")).not.toMatch(/bridge-token-value|broker-capability-value/);
  });
});

describe("managed GitHub launcher with broker candidates (myrmidon P6)", () => {
  async function startBroker(handler: Parameters<typeof createServer>[1]): Promise<{ server: Server; port: number }> {
    const server = createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    return { server, port: (server.address() as { port: number }).port };
  }

  async function deadPort(): Promise<number> {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return port;
  }

  async function stageGh() {
    const root = await mkdtemp(path.join(os.tmpdir(), "myrmidon-github-broker-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const bin = path.join(root, "managed");
    const realBin = path.join(root, "real");
    await mkdir(bin);
    await mkdir(realBin);
    await writeFile(path.join(bin, "gh"), githubLauncherSource(), { mode: 0o700 });
    await writeFile(
      path.join(realBin, "gh"),
      "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ token: process.env.GH_TOKEN ?? null }));",
      { mode: 0o700 },
    );
    return { bin, realBin };
  }

  function launcherEnv(input: { bin: string; realBin: string; brokerUrl: string; extra?: Record<string, string> }) {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...githubBrokerEnvironment({ GH_TOKEN: "host-token" }, { url: input.brokerUrl, token: "run-capability" }),
      PATH: `${input.bin}:${input.realBin}:${process.env.PATH}`,
    };
    delete env.PAPERCLIP_API_URL;
    delete env.PAPERCLIP_RUNTIME_API_URL;
    delete env.PAPERCLIP_RUNTIME_API_CANDIDATES_JSON;
    delete env.PAPERCLIP_GITHUB_BRIDGE_TOKEN;
    delete env.PAPERCLIP_API_KEY;
    return { ...env, ...input.extra };
  }

  it("gets credentials from a later candidate when the broker URL is unreachable", async () => {
    const { bin, realBin } = await stageGh();
    const { port } = await startBroker((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ status: "available", env: { GH_TOKEN: "managed-credential" } }));
    });
    const unreachable = await deadPort();
    const result = await exec(path.join(bin, "gh"), [], {
      env: launcherEnv({
        bin,
        realBin,
        brokerUrl: `http://127.0.0.1:${unreachable}`,
        extra: { PAPERCLIP_RUNTIME_API_CANDIDATES_JSON: JSON.stringify([`http://127.0.0.1:${port}`]) },
      }),
    });
    expect(JSON.parse(result.stdout)).toEqual({ token: "managed-credential" });
    expect(result.stderr).not.toContain("continuing without managed credentials");
  });

  it("uses the runtime API URL when the broker and API URLs refuse", async () => {
    const { bin, realBin } = await stageGh();
    const refusing = await startBroker((_req, res) => {
      res.writeHead(400);
      res.end("client certificate required");
    });
    const { port } = await startBroker((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ status: "available", env: { GH_TOKEN: "managed-credential" } }));
    });
    const result = await exec(path.join(bin, "gh"), [], {
      env: launcherEnv({
        bin,
        realBin,
        brokerUrl: `http://127.0.0.1:${refusing.port}`,
        extra: { PAPERCLIP_RUNTIME_API_URL: `http://127.0.0.1:${port}` },
      }),
    });
    expect(JSON.parse(result.stdout)).toEqual({ token: "managed-credential" });
  });

  it("lists every tried candidate without tokens when all of them fail", async () => {
    const { bin, realBin } = await stageGh();
    const refusing = await startBroker((_req, res) => {
      res.writeHead(400);
      res.end();
    });
    const unreachable = await deadPort();
    const result = await exec(path.join(bin, "gh"), [], {
      env: launcherEnv({
        bin,
        realBin,
        brokerUrl: `http://127.0.0.1:${refusing.port}`,
        extra: { PAPERCLIP_RUNTIME_API_CANDIDATES_JSON: JSON.stringify([`http://127.0.0.1:${unreachable}`]) },
      }),
    });
    expect(JSON.parse(result.stdout)).toEqual({ token: null });
    expect(result.stderr).toContain(`http://127.0.0.1:${refusing.port}/runtime-tools/github/credentials -> 400`);
    expect(result.stderr).toContain(`http://127.0.0.1:${unreachable}/runtime-tools/github/credentials -> no_response`);
    expect(result.stderr).toContain("broker_response_unavailable");
    expect(result.stderr).not.toMatch(/host-token|run-capability/);
  });
});
