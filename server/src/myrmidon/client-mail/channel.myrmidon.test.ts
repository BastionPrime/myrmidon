// myrmidon(EXTCASE-M): the channel to the mail module.
//
// The channel is the board's only way to reach the client's PC, so the tests are
// about the two things it must never do: send a malformed action to a Windows
// service, and turn a module's honest refusal ("Outlook is not running") into a
// thrown value that would lose the mail item.

import { describe, expect, it, vi } from "vitest";
import {
  applyMailDecision,
  callMailModule,
  fetchMailAttachment,
  listMail,
  mailModuleStatus,
  parseModuleResponse,
  prepareModuleRequest,
  type ClientMailChannel,
} from "./channel.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";

const channel = (answer: unknown): ClientMailChannel => ({ send: vi.fn(async (_input: { companyId: string; request: unknown }) => answer) });

describe("prepareModuleRequest", () => {
  it("passes a known action through", () => {
    const prepared = prepareModuleRequest({ action: "mail.read", messageId: "m-1" });
    expect(prepared).toEqual({ ok: true, value: { action: "mail.read", messageId: "m-1" } });
  });

  it("refuses an unknown action locally, without reaching the module", () => {
    const prepared = prepareModuleRequest({ action: "mail.nuke", messageId: "m-1" });
    expect(prepared).toMatchObject({ ok: false, reason: "invalid_request" });
    if (!prepared.ok) expect(prepared.message).toContain("not a known mail action");
  });

  it("refuses an action missing its own field", () => {
    expect(prepareModuleRequest({ action: "mail.move", messageId: "m-1" })).toMatchObject({
      ok: false,
      reason: "invalid_request",
    });
  });
});

describe("parseModuleResponse", () => {
  const read = (payload: unknown) => (typeof payload === "string" ? payload : null);

  it("reads a successful answer", () => {
    expect(parseModuleResponse({ ok: true, result: "value" }, read)).toEqual({ ok: true, value: "value" });
  });

  it("turns a refusal into a reported failure carrying the module's own code", () => {
    const parsed = parseModuleResponse(
      { ok: false, error: "outlook_not_running", message: "Outlook is closed" },
      read,
    );
    expect(parsed).toMatchObject({ ok: false, reason: "module_refused", code: "outlook_not_running" });
  });

  it("reports a value that is not an object", () => {
    expect(parseModuleResponse("nope", read)).toMatchObject({ ok: false, reason: "invalid_response" });
  });

  it("reports an unusable result rather than returning it", () => {
    expect(parseModuleResponse({ ok: true, result: 42 }, read)).toMatchObject({
      ok: false,
      reason: "invalid_response",
    });
  });

  it("reports a refusal that names no code", () => {
    expect(parseModuleResponse({ ok: false }, read)).toMatchObject({ code: "unknown", reason: "module_refused" });
  });
});

describe("callMailModule", () => {
  it("validates before sending: a malformed request never reaches the transport", async () => {
    const send = vi.fn();
    const result = await callMailModule(
      { send },
      { companyId: COMPANY_ID, request: { action: "mail.teleport" }, readResult: () => null },
    );
    expect(result).toMatchObject({ ok: false, reason: "invalid_request" });
    expect(send).not.toHaveBeenCalled();
  });

  it("reports a transport failure as data", async () => {
    const result = await callMailModule(
      {
        async send() {
          throw new Error("socket closed");
        },
      },
      { companyId: COMPANY_ID, request: { action: "mail.status" }, readResult: () => null },
    );
    expect(result).toMatchObject({ ok: false, reason: "transport_failed", message: "socket closed" });
  });
});

describe("the typed calls", () => {
  it("reports the module status of the client's Outlook", async () => {
    const result = await mailModuleStatus(
      channel({ ok: true, result: { outlookRunning: true, classicOutlook: false, error: "outlook_new_client" } }),
      COMPANY_ID,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.error).toBe("outlook_new_client");
  });

  it("caps the batch limit the board may ask for", async () => {
    const send = vi.fn(async (_input: { companyId: string; request: unknown }) => ({ ok: true, result: { watermark: "cursor", items: [] } }));
    await listMail({ send }, COMPANY_ID, { limit: 10_000 });
    const request = send.mock.calls[0]![0].request as { limit: number };
    expect(request.limit).toBe(500);
  });

  it("omits an empty watermark and defaults the limit", async () => {
    const send = vi.fn(async (_input: { companyId: string; request: unknown }) => ({ ok: true, result: { watermark: "cursor", items: [] } }));
    await listMail({ send }, COMPANY_ID, { watermark: "" });
    const request = send.mock.calls[0]![0].request as Record<string, unknown>;
    expect(request).not.toHaveProperty("watermark");
    expect(request.limit).toBe(500);
  });

  it("reads the bytes of one attachment", async () => {
    const result = await fetchMailAttachment(
      channel({
        ok: true,
        result: { messageId: "m-1", attachmentId: "a-1", name: "документация.pdf", base64: "JVBERi0=" },
      }),
      COMPANY_ID,
      { messageId: "m-1", attachmentId: "a-1" },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.name).toBe("документация.pdf");
  });

  it("applies a folder decision as a move", async () => {
    const send = vi.fn(async (_input: { companyId: string; request: unknown }) => ({ ok: true }));
    const result = await applyMailDecision({ send }, COMPANY_ID, {
      messageId: "m-1",
      decision: { kind: "folder", folderPath: "Tenders" },
    });
    expect(result).toEqual({ ok: true, value: { applied: true } });
    expect(send.mock.calls[0]![0].request).toEqual({ action: "mail.move", messageId: "m-1", folderPath: "Tenders" });
  });

  it("applies a category decision as a categorize", async () => {
    const send = vi.fn(async (_input: { companyId: string; request: unknown }) => ({ ok: true }));
    await applyMailDecision({ send }, COMPANY_ID, {
      messageId: "m-1",
      decision: { kind: "category", categories: ["Urgent"] },
    });
    expect(send.mock.calls[0]![0].request).toEqual({
      action: "mail.categorize",
      messageId: "m-1",
      categories: ["Urgent"],
    });
  });

  it("reports a decision the module cannot apply rather than pretending it worked", async () => {
    const result = await applyMailDecision(
      channel({ ok: false, error: "folder_not_found", message: "no such folder" }),
      COMPANY_ID,
      { messageId: "m-1", decision: { kind: "folder", folderPath: "Nope" } },
    );
    expect(result).toMatchObject({ ok: false, reason: "module_refused", code: "folder_not_found" });
  });

  it("carries the company on every call, so one client's module serves one client", async () => {
    const send = vi.fn(async (_input: { companyId: string; request: unknown }) => ({ ok: true, result: { outlookRunning: true, classicOutlook: true } }));
    await mailModuleStatus({ send }, COMPANY_ID);
    expect(send.mock.calls[0]![0].companyId).toBe(COMPANY_ID);
  });
});