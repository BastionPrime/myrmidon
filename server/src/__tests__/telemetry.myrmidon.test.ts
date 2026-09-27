import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.js";
import { createFeedbackTraceShareClientFromConfig } from "../services/feedback-share-client.js";
import { announcementFeedService } from "../services/announcement-feed.js";

// Myrmidon guard: with no settings the server neither sends telemetry nor
// shares feedback traces nor polls an announcement feed.

const CLEARED_ENV = [
  "PAPERCLIP_TELEMETRY_DISABLED",
  "DO_NOT_TRACK",
  "CI",
  "CONTINUOUS_INTEGRATION",
  "BUILD_NUMBER",
  "GITHUB_ACTIONS",
  "GITLAB_CI",
  "PAPERCLIP_TELEMETRY_ENDPOINT",
  "PAPERCLIP_FEEDBACK_EXPORT_BACKEND_URL",
  "PAPERCLIP_TELEMETRY_BACKEND_URL",
  "PAPERCLIP_ANNOUNCEMENTS_ENABLED",
  "PAPERCLIP_ANNOUNCEMENTS_FEED_URL",
];

describe("myrmidon server telemetry defaults", () => {
  beforeEach(() => {
    for (const key of CLEARED_ENV) vi.stubEnv(key, undefined);
    vi.stubEnv("PAPERCLIP_CONFIG", path.join(os.tmpdir(), "myrmidon-telemetry-test", "missing-config.json"));
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true })));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("loads config with telemetry and the announcement feed off", () => {
    const config = loadConfig();
    expect(config.telemetryEnabled).toBe(false);
    expect(config.announcementsEnabled).toBe(false);
    expect(config.announcementsFeedUrl).toBe("");
    expect(config.feedbackExportBackendUrl).toBeUndefined();
  });

  it("does not create a telemetry client by default or with the flag alone", async () => {
    const { initTelemetry } = await import("../telemetry.js");
    expect(initTelemetry({ enabled: loadConfig().telemetryEnabled })).toBeNull();
    expect(initTelemetry({ enabled: true })).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("has no feedback share client without an explicit backend", () => {
    expect(createFeedbackTraceShareClientFromConfig(loadConfig())).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not request the announcement feed without settings", async () => {
    const feedFetch = vi.fn(async () => new Response("{}"));
    const config = loadConfig();
    const service = announcementFeedService({
      enabled: config.announcementsEnabled,
      feedUrl: config.announcementsFeedUrl,
      version: "1.0.0",
      fetch: feedFetch,
    });
    expect(await service.current()).toBeNull();
    expect(await service.image("any")).toBeNull();

    // Even when a caller leaves the options out, there is no default feed.
    expect(await announcementFeedService({ version: "1.0.0", fetch: feedFetch }).current()).toBeNull();
    expect(feedFetch).not.toHaveBeenCalled();
  });
});
