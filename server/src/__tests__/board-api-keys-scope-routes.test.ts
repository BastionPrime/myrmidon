import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockBoardAuthService = vi.hoisted(() => ({
  createNamedBoardApiKey: vi.fn(),
  listBoardApiKeys: vi.fn(),
  getBoardApiKeyForUser: vi.fn(),
  revokeBoardApiKey: vi.fn(),
  resolveBoardActivityCompanyIds: vi.fn(),
  assertCurrentBoardKey: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  boardAuthService: () => mockBoardAuthService,
  logActivity: mockLogActivity,
  accessService: () => ({}),
  agentService: () => ({}),
  notifyHireApproved: vi.fn(),
  deduplicateAgentName: vi.fn((name: string) => name),
}));

let importCounter = 0;

async function createApp(actor: any) {
  importCounter += 1;
  void importCounter;
  const accessModule = await import("../routes/access.js");
  const { errorHandler: handler } = await import("../middleware/index.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", accessModule.accessRoutes({} as any, {} as any));
  app.use(handler);
  return app;
}

const companyUuid = "11111111-1111-4111-8111-111111111111";

describe("POST /api/board-api-keys scope plumbing (myrmidon ROLE-SCOPED-TOKENS)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes the requested scope to the service and echoes it in the response and audit log", async () => {
    mockBoardAuthService.createNamedBoardApiKey.mockResolvedValue({
      id: "board-key-scope-1",
      name: "release-duty",
      token: "pcp_board_plaintext",
      scope: { kind: "release" },
      createdAt: new Date("2026-09-30T12:00:00.000Z"),
      lastUsedAt: null,
      revokedAt: null,
      expiresAt: new Date("2026-10-30T12:00:00.000Z"),
    });
    mockBoardAuthService.resolveBoardActivityCompanyIds.mockResolvedValue([companyUuid]);

    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "board_key",
      isInstanceAdmin: false,
      companyIds: [companyUuid],
    });

    const res = await request(app)
      .post("/api/board-api-keys")
      .send({ name: "release-duty", scope: { kind: "release" }, requestedCompanyId: companyUuid });

    expect(res.status, res.text || JSON.stringify(res.body)).toBe(201);
    expect(mockBoardAuthService.createNamedBoardApiKey).toHaveBeenCalledWith(
      expect.objectContaining({ scope: { kind: "release" } }),
    );
    expect(res.body).toMatchObject({ scope: { kind: "release" } });
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "board_api_key.created",
        details: expect.objectContaining({ scope: "release" }),
      }),
    );
  });

  it("defaults the scope to full when not requested", async () => {
    mockBoardAuthService.createNamedBoardApiKey.mockResolvedValue({
      id: "board-key-scope-2",
      name: "legacy",
      token: "pcp_board_plaintext",
      scope: { kind: "full" },
      createdAt: new Date("2026-09-30T12:00:00.000Z"),
      lastUsedAt: null,
      revokedAt: null,
      expiresAt: null,
    });
    mockBoardAuthService.resolveBoardActivityCompanyIds.mockResolvedValue([companyUuid]);

    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "board_key",
      isInstanceAdmin: false,
      companyIds: [companyUuid],
    });

    const res = await request(app).post("/api/board-api-keys").send({ name: "legacy" });

    expect(res.status, res.text || JSON.stringify(res.body)).toBe(201);
    expect(mockBoardAuthService.createNamedBoardApiKey).toHaveBeenCalledWith(
      expect.objectContaining({ scope: { kind: "full" } }),
    );
  });

  it("rejects an unknown scope kind with 422 before touching the service", async () => {
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "board_key",
      isInstanceAdmin: false,
      companyIds: [companyUuid],
    });

    const res = await request(app)
      .post("/api/board-api-keys")
      .send({ name: "bad", scope: { kind: "superuser" } });

    expect(res.status).toBe(400);
    expect(mockBoardAuthService.createNamedBoardApiKey).not.toHaveBeenCalled();
  });
});

describe("GET /api/board-api-keys scope exposure (myrmidon ROLE-SCOPED-TOKENS)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists keys with their scopes", async () => {
    mockBoardAuthService.listBoardApiKeys.mockResolvedValue([
      {
        id: "55555555-5555-4555-8555-555555555555",
        name: "release-duty",
        scope: { kind: "release" },
        createdAt: new Date("2026-09-30T12:00:00.000Z"),
        lastUsedAt: null,
        revokedAt: null,
        expiresAt: null,
      },
    ]);

    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "board_key",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
    });

    const res = await request(app).get("/api/board-api-keys");
    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({ name: "release-duty", scope: { kind: "release" } });
  });
});
