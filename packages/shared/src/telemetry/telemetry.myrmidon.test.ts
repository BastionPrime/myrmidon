import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TelemetryClient } from "./client.js";
import { resolveTelemetryConfig } from "./config.js";
import { paperclipConfigSchema } from "../config-schema.js";

// Myrmidon guard: vendor telemetry is off by default. Enabling it needs two
// explicit actions: the config flag and an operator-owned endpoint.

const DISABLING_ENV = [
  "PAPERCLIP_TELEMETRY_DISABLED",
  "DO_NOT_TRACK",
  "CI",
  "CONTINUOUS_INTEGRATION",
  "BUILD_NUMBER",
  "GITHUB_ACTIONS",
  "GITLAB_CI",
  "PAPERCLIP_TELEMETRY_ENDPOINT",
];

const STATE = {
  installId: "install-a",
  salt: "salt-a",
  createdAt: "2026-01-01T00:00:00.000Z",
  firstSeenVersion: "0.0.0",
};

describe("myrmidon telemetry defaults", () => {
  beforeEach(() => {
    // Clear everything that would disable telemetry on its own, so the
    // assertions below prove the default rather than the CI environment.
    for (const key of DISABLING_ENV) vi.stubEnv(key, undefined);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true })));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("is disabled without any configuration", () => {
    expect(resolveTelemetryConfig().enabled).toBe(false);
    expect(resolveTelemetryConfig({}).enabled).toBe(false);
  });

  it("stays disabled with the flag but no endpoint", () => {
    expect(resolveTelemetryConfig({ enabled: true }).enabled).toBe(false);
    vi.stubEnv("PAPERCLIP_TELEMETRY_ENDPOINT", "   ");
    expect(resolveTelemetryConfig({ enabled: true }).enabled).toBe(false);
  });

  it("stays disabled with an endpoint but no flag", () => {
    vi.stubEnv("PAPERCLIP_TELEMETRY_ENDPOINT", "https://telemetry.example.com/ingest");
    expect(resolveTelemetryConfig().enabled).toBe(false);
    expect(resolveTelemetryConfig({ enabled: false }).enabled).toBe(false);
  });

  it("is enabled only with both the flag and an explicit endpoint", () => {
    vi.stubEnv("PAPERCLIP_TELEMETRY_ENDPOINT", "https://telemetry.example.com/ingest");
    const config = resolveTelemetryConfig({ enabled: true });
    expect(config.enabled).toBe(true);
    expect(config.endpoint).toBe("https://telemetry.example.com/ingest");
  });

  it("keeps the vendor opt-out switches working", () => {
    vi.stubEnv("PAPERCLIP_TELEMETRY_ENDPOINT", "https://telemetry.example.com/ingest");
    vi.stubEnv("DO_NOT_TRACK", "1");
    expect(resolveTelemetryConfig({ enabled: true }).enabled).toBe(false);
  });

  it("defaults the config-file flag to disabled", () => {
    const parsed = paperclipConfigSchema.shape.telemetry.parse(undefined);
    expect(parsed.enabled).toBe(false);
  });

  it("never calls fetch when the client has no endpoint", async () => {
    const client = new TelemetryClient({ enabled: true }, () => STATE, "0.0.0-test");
    client.track("install.started", {});
    await client.flush();
    client.stop();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sends only to the explicitly configured endpoint", async () => {
    const client = new TelemetryClient(
      { enabled: true, endpoint: "https://telemetry.example.com/ingest" },
      () => STATE,
      "0.0.0-test",
    );
    client.track("install.started", {});
    await client.flush();
    client.stop();
    expect(vi.mocked(fetch).mock.calls.map((call) => String(call[0]))).toEqual([
      "https://telemetry.example.com/ingest",
    ]);
  });
});

// Vendor hosts that must not appear in shipped source. Tests, fixtures and
// release notes are allowed to mention them.
const VENDOR_HOSTS = /telemetry\.paperclip\.ing|execute-api\.us-east-1\.amazonaws\.com|pages\.paperclip\.ing/;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const SOURCE_ROOTS = ["server/src", "cli/src", "packages", "ui/src"];
const SKIP_DIRS = new Set(["node_modules", "dist", "__tests__", "__fixtures__", "fixtures", "storybook", "releases", "generated-test"]);
const SOURCE_FILE = /\.(ts|tsx|js|mjs|cjs|json)$/;
const TEST_FILE = /\.(test|spec)\.(ts|tsx|js|mjs)$/;

function collectSourceFiles(dir: string, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      collectSourceFiles(path.join(dir, entry.name), out);
    } else if (SOURCE_FILE.test(entry.name) && !TEST_FILE.test(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }
}

describe("myrmidon vendor telemetry hosts", () => {
  it("are absent from shipped source", () => {
    const files: string[] = [];
    for (const root of SOURCE_ROOTS) collectSourceFiles(path.join(REPO_ROOT, root), files);
    expect(files.length).toBeGreaterThan(100);
    const offenders = files
      .filter((file) => VENDOR_HOSTS.test(fs.readFileSync(file, "utf8")))
      .map((file) => path.relative(REPO_ROOT, file));
    expect(offenders).toEqual([]);
  });
});
