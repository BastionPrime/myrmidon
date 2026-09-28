import { describe, expect, it } from "vitest";
import { absolutizeBoardLinks, resolveBoardPublicBaseUrl } from "./links.js";

// Deliberately permissive: exercises the pure rewriting behavior in
// `absolutizeBoardLinks` on its own, without also depending on
// `sanitizeExternalChatUrl`'s https-only, public-host policy (covered
// separately below).
const passthroughSanitize = (url: string): string | null => url;

describe("myrmidon(X8g) absolutizeBoardLinks", () => {
  const base = "https://board.example.com";

  it("absolutizes a markdown link to a board task page", () => {
    const text = "Created [ABC-1](/issues/abc-1) for you.";
    expect(absolutizeBoardLinks(text, base, passthroughSanitize)).toBe(
      "Created [ABC-1](https://board.example.com/issues/abc-1) for you.",
    );
  });

  it("absolutizes a markdown link to a board project page", () => {
    const text = "See [the project](/projects/proj-1).";
    expect(absolutizeBoardLinks(text, base, passthroughSanitize)).toBe(
      "See [the project](https://board.example.com/projects/proj-1).",
    );
  });

  it("absolutizes a bare board path in running prose, keeping trailing punctuation outside the link", () => {
    const text = "Open /issues/abc-1, then check /projects/proj-1.";
    expect(absolutizeBoardLinks(text, base, passthroughSanitize)).toBe(
      "Open https://board.example.com/issues/abc-1, then check https://board.example.com/projects/proj-1.",
    );
  });

  it("leaves a fenced code block untouched", () => {
    const text = ["Example:", "```", "GET /issues/abc-1", "```", "done"].join(
      "\n",
    );
    expect(absolutizeBoardLinks(text, base, passthroughSanitize)).toBe(text);
  });

  it("leaves an inline code span untouched", () => {
    const text = "Run `curl /issues/abc-1` locally.";
    expect(absolutizeBoardLinks(text, base, passthroughSanitize)).toBe(text);
  });

  it("leaves an already-external link untouched", () => {
    const text = "See [vendor docs](https://example.com/issues/1) instead.";
    expect(absolutizeBoardLinks(text, base, passthroughSanitize)).toBe(text);
  });

  it("leaves an already-absolute board link untouched", () => {
    const text = `Already absolute: [ABC-1](${base}/issues/abc-1).`;
    expect(absolutizeBoardLinks(text, base, passthroughSanitize)).toBe(text);
  });

  it("returns the text unchanged without a public base URL", () => {
    const text = "Created [ABC-1](/issues/abc-1) for you.";
    expect(absolutizeBoardLinks(text, null, passthroughSanitize)).toBe(text);
    expect(absolutizeBoardLinks(text, undefined, passthroughSanitize)).toBe(
      text,
    );
    expect(absolutizeBoardLinks(text, "", passthroughSanitize)).toBe(text);
  });

  it("leaves a link unchanged when the sanitizer rejects the combined URL", () => {
    const text = "Created [ABC-1](/issues/abc-1) for you.";
    expect(absolutizeBoardLinks(text, base, () => null)).toBe(text);
  });

  it("uses the real outgoing-chat sanitizer by default, rejecting a non-https base", () => {
    const text = "Created [ABC-1](/issues/abc-1) for you.";
    // No sanitize override: the default (sanitizeExternalChatUrl) only
    // accepts a public https origin, so an http:// deploy base is rejected
    // and the link is left as-is rather than published half-broken.
    expect(absolutizeBoardLinks(text, "http://127.0.0.1:3100")).toBe(text);
  });
});

describe("myrmidon(X8g) resolveBoardPublicBaseUrl", () => {
  it("returns null with no relevant environment variable set", () => {
    expect(resolveBoardPublicBaseUrl({})).toBeNull();
  });

  it("prefers PAPERCLIP_AUTH_PUBLIC_BASE_URL over the other fallbacks", () => {
    expect(
      resolveBoardPublicBaseUrl({
        PAPERCLIP_AUTH_PUBLIC_BASE_URL: "https://from-auth.example.com",
        PAPERCLIP_PUBLIC_URL: "https://from-public-url.example.com",
      } as NodeJS.ProcessEnv),
    ).toBe("https://from-auth.example.com");
  });

  it("falls back to PAPERCLIP_PUBLIC_URL", () => {
    expect(
      resolveBoardPublicBaseUrl({
        PAPERCLIP_PUBLIC_URL: "https://from-public-url.example.com",
      } as NodeJS.ProcessEnv),
    ).toBe("https://from-public-url.example.com");
  });
});
