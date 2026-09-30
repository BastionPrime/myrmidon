// myrmidon(ABOUT): tests for the About build-info module and route.
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../../middleware/index.js";
import { readAboutBuildInfo, resolveAboutVersion } from "./build-info.js";
import { aboutRoutes } from "./routes.js";

// The route imports resolve through the real module, so pin the stamped
// values via env instead of mocking the version module wholesale.
const BASE_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...BASE_ENV };
  vi.restoreAllMocks();
});

function withEnv(env: Record<string, string>) {
  process.env = { ...BASE_ENV, ...env };
}

describe("readAboutBuildInfo", () => {
  it("reports the stamped release version, commit, build date and vendor base", () => {
    withEnv({
      PAPERCLIP_BUILD_VERSION: "1.2.1",
      PAPERCLIP_BUILD_COMMIT: "0123456789abcdef0123456789abcdef01234567",
      MYRMIDON_BUILD_DATE: "2026-09-28T10:11:12Z",
      MYRMIDON_BASE_PAPERCLIP: "2026.916.1",
      MYRMIDON_IMAGE_DIGEST: "ghcr.io/itkadr-git/myrmidon@sha256:" + "a".repeat(64),
    });
    expect(readAboutBuildInfo()).toMatchObject({
      product: "Myrmidon",
      version: "1.2.1",
      commit: "0123456789abcdef0123456789abcdef01234567",
      buildDate: "2026-09-28T10:11:12.000Z",
      basePaperclipVersion: "2026.916.1",
      imageDigest: "sha256:" + "a".repeat(64),
      license: "MIT",
      links: {
        repo: "https://github.com/itkadr-git/myrmidon",
        changelog:
          "https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/CHANGELOG.md",
        docs: "https://github.com/itkadr-git/myrmidon/tree/main/docs/myrmidon",
      },
    });
  });

  it("accepts a date-only build stamp and a bare digest", () => {
    withEnv({
      MYRMIDON_BUILD_DATE: "2026-09-28",
      MYRMIDON_IMAGE_DIGEST: "sha256:" + "0".repeat(64),
    });
    expect(readAboutBuildInfo().buildDate).toBe("2026-09-28T00:00:00.000Z");
    expect(readAboutBuildInfo().imageDigest).toBe("sha256:" + "0".repeat(64));
  });

  it("drops malformed stamps instead of echoing them", () => {
    withEnv({
      PAPERCLIP_BUILD_VERSION: "1.2.1 ../../../etc",
      PAPERCLIP_BUILD_COMMIT: "not-a-sha",
      MYRMIDON_BUILD_DATE: "yesterday",
      MYRMIDON_BASE_PAPERCLIP: "vendor-latest",
      MYRMIDON_IMAGE_DIGEST: "sha256:short",
    });
    const info = readAboutBuildInfo();
    expect(info.version).toBe(resolveAboutVersion(process.env));
    expect(info.commit).toBeNull();
    expect(info.buildDate).toBeNull();
    expect(info.basePaperclipVersion).toBeNull();
    expect(info.imageDigest).toBeNull();
  });

  it("falls back to the running version when nothing is stamped", () => {
    withEnv({
      PAPERCLIP_BUILD_VERSION: "",
      PAPERCLIP_BUILD_COMMIT: "",
      MYRMIDON_BUILD_DATE: "",
      MYRMIDON_BASE_PAPERCLIP: "",
      MYRMIDON_IMAGE_DIGEST: "",
    });
    const info = readAboutBuildInfo();
    expect(info.version).toBeTruthy();
    expect(info.product).toBe("Myrmidon");
    expect(info.license).toBe("MIT");
  });
});

describe("GET /api/myrmidon/about", () => {
  function app(actor: unknown) {
    const server = express();
    server.use((_req, _res, next) => {
      (_req as unknown as { actor: unknown }).actor = actor;
      next();
    });
    server.use("/api", aboutRoutes());
    server.use(errorHandler);
    return server;
  }

  const board = { type: "board", source: "session", userId: "user-a", isInstanceAdmin: true, companyIds: ["c"] };
  const agent = { type: "agent", source: "agent_key", agentId: "a", companyId: "c", keyId: "k" };
  const anonymous = { type: "none" };

  it("serves build info to board and agent actors", async () => {
    withEnv({ PAPERCLIP_BUILD_VERSION: "1.2.1" });
    for (const actor of [board, agent]) {
      const res = await request(app(actor)).get("/api/myrmidon/about").expect(200);
      expect(res.body).toMatchObject({ product: "Myrmidon", version: "1.2.1" });
    }
  });

  it("rejects anonymous callers", async () => {
    await request(app(anonymous)).get("/api/myrmidon/about").expect(403);
  });
});
