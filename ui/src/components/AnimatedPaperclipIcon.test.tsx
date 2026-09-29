// @vitest-environment node

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PaperclipLoading } from "./AnimatedPaperclipIcon";

describe("PaperclipLoading", () => {
  it("renders an accessible full-page loading state", () => {
    const html = renderToStaticMarkup(<PaperclipLoading />);

    expect(html).toContain('role="status"');
    expect(html).toContain("min-h-dvh");
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('<span class="sr-only">Loading…</span>');
  });

  // myrmidon(B1a): the loading indicator is the Myrmidon ant, not a paperclip.
  it("renders the Myrmidon ant mark for light and dark themes, not a paperclip glyph", () => {
    const html = renderToStaticMarkup(<PaperclipLoading />);

    expect(html).toContain('src="/brand/myrmidon/myrmidon-mark.svg"');
    expect(html).toContain('src="/brand/myrmidon/myrmidon-mark-white.svg"');
    expect(html).not.toContain("<svg");
    expect(html).not.toContain("paperclip");
  });

  it("pulses only when the user has not asked for reduced motion", () => {
    const html = renderToStaticMarkup(<PaperclipLoading />);

    expect(html).toContain("motion-safe:animate-pulse");
    // Every animate-pulse in the markup must carry the motion-safe: variant.
    expect(html.replace(/motion-safe:animate-pulse/g, "")).not.toContain("animate-pulse");
  });

  it("allows containing layouts to override the full-page height", () => {
    const html = renderToStaticMarkup(<PaperclipLoading className="min-h-0" />);

    expect(html).toContain("min-h-0");
    expect(html).not.toContain("min-h-dvh");
  });
});
