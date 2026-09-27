import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkForUpdateNotice, isUpdateNoticeEnabled } from "../update-notice.js";

// Myrmidon guard: the CLI never asks the vendor npm registry for updates by
// default. Only an explicit PAPERCLIP_UPDATE_CHECK_URL enables the check.

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "myrmidon-notice-"));
  vi.stubEnv("PAPERCLIP_UPDATE_CHECK", undefined);
  vi.stubEnv("PAPERCLIP_UPDATE_CHECK_URL", undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("myrmidon update notice defaults", () => {
  it("is disabled without an explicit URL, even with the config flag on", () => {
    const config = path.join(root, "config.json");
    fs.writeFileSync(config, JSON.stringify({ updates: { checkEnabled: true } }));
    expect(isUpdateNoticeEnabled(config)).toBe(false);
    expect(isUpdateNoticeEnabled(path.join(root, "missing.json"))).toBe(false);
  });

  it("never fetches without an explicit URL", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    expect(await checkForUpdateNotice({ cachePath: path.join(root, "cache.json"), now: 1000, fetchImpl })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fetches only the configured URL", async () => {
    vi.stubEnv("PAPERCLIP_UPDATE_CHECK_URL", "https://registry.example.com/paperclipai");
    const fetchImpl = vi.fn(async (_url: string | URL | Request) => new Response(JSON.stringify({ "dist-tags": { latest: "99.0.0" } }), { status: 200 }));
    await checkForUpdateNotice({ cachePath: path.join(root, "cache.json"), now: 1000, fetchImpl, configPath: path.join(root, "missing.json") });
    expect(fetchImpl.mock.calls.map((call) => String(call[0]))).toEqual(["https://registry.example.com/paperclipai"]);
  });

  it("keeps the vendor kill switch", () => {
    vi.stubEnv("PAPERCLIP_UPDATE_CHECK_URL", "https://registry.example.com/paperclipai");
    vi.stubEnv("PAPERCLIP_UPDATE_CHECK", "0");
    expect(isUpdateNoticeEnabled(path.join(root, "missing.json"))).toBe(false);
  });
});
