// myrmidon(EXTCASE-M): the classifier step.
//
// The classifier is the one place in the mail path where a model sees a client's
// mail, so the tests are about its two guarantees: the body sent is capped, and a
// failed or off-vocabulary answer never loses or misroutes the message.

import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CLIENT_MAIL_COMPANY_SETTINGS, type ClientMailCompanySettings, type ClientMailItem } from "@paperclipai/shared";
import {
  MailClassifierError,
  buildClassifierPrompt,
  classifierCompletionUrl,
  createMailClassifier,
  readClassifierAnswer,
} from "./classifier.js";

function item(overrides: Partial<ClientMailItem> = {}): ClientMailItem {
  return {
    messageId: "m-1",
    receivedAt: "2026-10-01T09:00:00Z",
    subject: "Извещение о закупке",
    from: { address: "tender@example.com" },
    bodyText: "x".repeat(10_000),
    ...overrides,
  };
}

function settings(overrides: Partial<ClientMailCompanySettings> = {}): ClientMailCompanySettings {
  return { ...DEFAULT_CLIENT_MAIL_COMPANY_SETTINGS, folders: ["Tenders"], categories: ["Urgent"], ...overrides };
}

function chatResponse(content: string, status = 200): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("classifierCompletionUrl", () => {
  it("adds /v1/chat/completions to a bare gateway address", () => {
    expect(classifierCompletionUrl("http://gateway.internal:4000")).toBe("http://gateway.internal:4000/v1/chat/completions");
  });

  it("does not double the /v1 segment", () => {
    expect(classifierCompletionUrl("http://gateway.internal:4000/v1")).toBe("http://gateway.internal:4000/v1/chat/completions");
    expect(classifierCompletionUrl("http://gateway.internal:4000/v1/")).toBe("http://gateway.internal:4000/v1/chat/completions");
  });
});

describe("buildClassifierPrompt", () => {
  it("names the folder, the subject and the sender, and closes the answer shape", () => {
    const prompt = buildClassifierPrompt({
      model: "m",
      folders: ["Tenders", "Invoices"],
      categories: ["Urgent"],
      bodyText: "body",
      subject: "Subject line",
      fromAddress: "tender@example.com",
      attachmentNames: ["d.pdf"],
    });
    expect(prompt).toContain("Folders: Tenders, Invoices");
    expect(prompt).toContain("Categories: Urgent");
    expect(prompt).toContain("Subject: Subject line");
    expect(prompt).toContain("From: tender@example.com");
    expect(prompt).toContain("d.pdf");
    expect(prompt).toContain("Never invent a folder or a category.");
  });

  it("says so when the client configured no folders or categories", () => {
    const prompt = buildClassifierPrompt({
      model: "m",
      folders: [],
      categories: [],
      bodyText: "",
      subject: "s",
      fromAddress: null,
      attachmentNames: [],
    });
    expect(prompt).toContain("Folders: (none)");
    expect(prompt).toContain("From: (unknown)");
  });
});

describe("readClassifierAnswer", () => {
  it("reads a bare JSON object", () => {
    expect(readClassifierAnswer('{"kind":"keep"}')).toEqual({ kind: "keep" });
  });

  it("reads an object inside a fenced block", () => {
    expect(readClassifierAnswer('```json\n{"kind":"keep"}\n```')).toEqual({ kind: "keep" });
  });

  it("reads an object wrapped in a sentence", () => {
    expect(readClassifierAnswer('Sure: {"kind":"keep"} — done.')).toEqual({ kind: "keep" });
  });

  it("returns null for an answer with no object at all", () => {
    expect(readClassifierAnswer("Tenders")).toBeNull();
  });
});

describe("createMailClassifier", () => {
  it("returns the decision of a well-formed answer", async () => {
    const fetchImpl = vi.fn(async () => chatResponse('{"kind":"folder","folderPath":"Tenders","reason":"tender"}'));
    const classifier = createMailClassifier("model-a", {
      fetch: fetchImpl as unknown as typeof fetch,
      baseUrl: "http://gateway.internal:4000",
      timeoutMs: 1000,
      readApiKey: async () => "key",
    });
    await expect(classifier.classify(item(), settings())).resolves.toEqual({
      kind: "folder",
      folderPath: "Tenders",
      source: "model",
      reason: "tender",
    });
  });

  it("caps the body it sends at the company's limit", async () => {
    let sent = "";
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      sent = String(init?.body ?? "");
      return chatResponse('{"kind":"keep"}');
    });
    const classifier = createMailClassifier("model-a", {
      fetch: fetchImpl as unknown as typeof fetch,
      baseUrl: "http://gateway.internal:4000",
      timeoutMs: 1000,
      readApiKey: async () => "key",
    });
    await classifier.classify(item(), settings({ maxBodyChars: 50 }));
    const body = JSON.parse(sent) as { messages: Array<{ content: string }> };
    expect(body.messages[0]!.content).not.toContain("x".repeat(51));
  });

  it("returns null when the answer names an option the client did not configure", async () => {
    const fetchImpl = vi.fn(async () => chatResponse('{"kind":"folder","folderPath":"Elsewhere"}'));
    const classifier = createMailClassifier("model-a", {
      fetch: fetchImpl as unknown as typeof fetch,
      baseUrl: "http://gateway.internal:4000",
      timeoutMs: 1000,
      readApiKey: async () => "key",
    });
    await expect(classifier.classify(item(), settings())).resolves.toBeNull();
  });

  it("reports a missing key rather than calling the gateway", async () => {
    const fetchImpl = vi.fn();
    const classifier = createMailClassifier("model-a", {
      fetch: fetchImpl as unknown as typeof fetch,
      baseUrl: "http://gateway.internal:4000",
      timeoutMs: 1000,
      readApiKey: async () => null,
    });
    await expect(classifier.classify(item(), settings())).rejects.toThrow(MailClassifierError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports a missing address rather than calling anything", async () => {
    const classifier = createMailClassifier("model-a", {
      fetch: (async () => chatResponse("{}")) as unknown as typeof fetch,
      baseUrl: null,
      timeoutMs: 1000,
      readApiKey: async () => "key",
    });
    await expect(classifier.classify(item(), settings())).rejects.toThrow(/no gateway address/);
  });

  it("reports a failing status without echoing the body", async () => {
    const fetchImpl = vi.fn(async () => new Response("provider says: subject was Извещение", { status: 502 }));
    const classifier = createMailClassifier("model-a", {
      fetch: fetchImpl as unknown as typeof fetch,
      baseUrl: "http://gateway.internal:4000",
      timeoutMs: 1000,
      readApiKey: async () => "key",
    });
    await expect(classifier.classify(item(), settings())).rejects.toThrow(/answered 502/);
    await expect(classifier.classify(item(), settings())).rejects.not.toThrow(/Извещение/);
  });

  it("reports an empty answer", async () => {
    const fetchImpl = vi.fn(async () => chatResponse(""));
    const classifier = createMailClassifier("model-a", {
      fetch: fetchImpl as unknown as typeof fetch,
      baseUrl: "http://gateway.internal:4000",
      timeoutMs: 1000,
      readApiKey: async () => "key",
    });
    await expect(classifier.classify(item(), settings())).rejects.toThrow(/empty answer/);
  });

  it("reports unreachable as a classifier error, never a thrown transport value", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const classifier = createMailClassifier("model-a", {
      fetch: fetchImpl as unknown as typeof fetch,
      baseUrl: "http://gateway.internal:4000",
      timeoutMs: 1000,
      readApiKey: async () => "key",
    });
    await expect(classifier.classify(item(), settings())).rejects.toThrow(/unreachable/);
  });

  it("sends the key as a bearer header and never in the body", async () => {
    let init: RequestInit | undefined;
    const fetchImpl = vi.fn(async (_url: string, options?: RequestInit) => {
      init = options;
      return chatResponse('{"kind":"keep"}');
    });
    const classifier = createMailClassifier("model-a", {
      fetch: fetchImpl as unknown as typeof fetch,
      baseUrl: "http://gateway.internal:4000",
      timeoutMs: 1000,
      readApiKey: async () => "secret-value",
    });
    await classifier.classify(item(), settings());
    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer secret-value");
    expect(String(init?.body)).not.toContain("secret-value");
  });
});