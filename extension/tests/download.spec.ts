import { describe, expect, it } from "vitest";
import { fetchFile, fileNameFromResponse } from "../src/download";

function response(body: Uint8Array, headers: Record<string, string>, ok = true, status = 200): Response {
  return {
    ok,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  } as unknown as Response;
}

function fetchReturning(value: Response | Error): typeof fetch {
  return (async () => {
    if (value instanceof Error) throw value;
    return value;
  }) as unknown as typeof fetch;
}

describe("fileNameFromResponse", () => {
  it("prefers the Content-Disposition file name", () => {
    expect(fileNameFromResponse("https://tender.example/x", 'attachment; filename="doc.pdf"')).toBe("doc.pdf");
    expect(fileNameFromResponse("https://tender.example/x", "attachment; filename*=UTF-8''%D0%B4%D0%BE%D0%BA.pdf")).toBe("док.pdf");
  });

  it("falls back to the last url path segment", () => {
    expect(fileNameFromResponse("https://tender.example/files/a.pdf", null)).toBe("a.pdf");
  });

  it("falls back to a generic name when there is no usable name", () => {
    expect(fileNameFromResponse("https://tender.example/", null)).toBe("download");
    expect(fileNameFromResponse("not a url", null)).toBe("download");
  });
});

describe("fetchFile", () => {
  it("returns the file bytes base64-encoded", async () => {
    const outcome = await fetchFile(
      "https://tender.example/doc.pdf",
      fetchReturning(response(new Uint8Array([1, 2, 3, 4]), { "content-type": "application/pdf", "content-disposition": 'filename="doc.pdf"' })),
    );
    expect(outcome).toEqual({
      ok: true,
      file: { name: "doc.pdf", mimeType: "application/pdf", byteLength: 4, base64: "AQIDBA==" },
    });
  });

  it("refuses a body above the bridge ceiling (red side)", async () => {
    const outcome = await fetchFile(
      "https://tender.example/huge.bin",
      fetchReturning(response(new Uint8Array([1]), { "content-length": String(25 * 1024 * 1024 + 1) })),
    );
    expect(outcome).toEqual({ ok: false, tooLarge: 25 * 1024 * 1024 + 1 });
  });

  it("turns a non-ok status into a message, not a file", async () => {
    const outcome = await fetchFile("https://tender.example/gone.pdf", fetchReturning(response(new Uint8Array([]), {}, false, 404)));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect("message" in outcome && outcome.message).toContain("404");
  });

  it("never throws: a failed fetch is an outcome", async () => {
    const outcome = await fetchFile("https://tender.example/x", fetchReturning(new Error("network down")));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect("message" in outcome && outcome.message).toContain("network down");
  });
});