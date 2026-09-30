import { describe, expect, it } from "vitest";
import {
  applyUiBranding,
  getWorktreeUiBranding,
  isWorktreeUiBrandingEnabled,
  renderFaviconLinks,
  renderRuntimeBrandingMeta,
  resolveIconVersion,
  versionIconUrl,
} from "../ui-branding.js";

const TEMPLATE = `<!doctype html>
<head>
    <!-- PAPERCLIP_RUNTIME_BRANDING_START -->
    <!-- PAPERCLIP_RUNTIME_BRANDING_END -->
    <!-- PAPERCLIP_FAVICON_START -->
    <link rel="icon" href="/favicon.ico" sizes="48x48" />
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png" />
    <link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png" />
    <!-- PAPERCLIP_FAVICON_END -->
</head>`;

describe("icon URL versioning", () => {
  const TEMPLATE_WITH_OUTSIDE = TEMPLATE.replace(
    "</head>",
    '<link rel="apple-touch-icon" href="/apple-touch-icon.png" />\n<link rel="manifest" href="/site.webmanifest" />\n<link rel="stylesheet" href="/assets/app.css" />\n</head>',
  );

  it("adds the build version to icon and manifest links", () => {
    const html = applyUiBranding(TEMPLATE_WITH_OUTSIDE, { PAPERCLIP_BUILD_VERSION: "1.2.2" });
    expect(html).toContain('href="/favicon.ico?v=1.2.2"');
    expect(html).toContain('href="/favicon.svg?v=1.2.2"');
    expect(html).toContain('href="/favicon-32x32.png?v=1.2.2"');
    expect(html).toContain('href="/apple-touch-icon.png?v=1.2.2"');
    expect(html).toContain('href="/site.webmanifest?v=1.2.2"');
    expect(html).toContain('href="/assets/app.css"');
  });

  it("changes the URLs when the version changes", () => {
    const a = applyUiBranding(TEMPLATE, { PAPERCLIP_BUILD_VERSION: "1.2.2" });
    const b = applyUiBranding(TEMPLATE, { PAPERCLIP_BUILD_VERSION: "1.2.3" });
    expect(a).not.toEqual(b);
    expect(b).toContain("/favicon.svg?v=1.2.3");
  });

  it("leaves links untouched without a version", () => {
    expect(resolveIconVersion({})).toBeNull();
    expect(applyUiBranding(TEMPLATE, {})).toContain('href="/favicon.svg" type');
  });

  it("only versions same-origin icon paths", () => {
    expect(versionIconUrl("https://example.com/favicon.svg", "1")).toBe("https://example.com/favicon.svg");
    expect(versionIconUrl("/favicon.svg", "1")).toBe("/favicon.svg?v=1");
  });
});

describe("ui branding", () => {
  it("detects worktree mode from PAPERCLIP_IN_WORKTREE", () => {
    expect(isWorktreeUiBrandingEnabled({ PAPERCLIP_IN_WORKTREE: "true" })).toBe(true);
    expect(isWorktreeUiBrandingEnabled({ PAPERCLIP_IN_WORKTREE: "1" })).toBe(true);
    expect(isWorktreeUiBrandingEnabled({ PAPERCLIP_IN_WORKTREE: "false" })).toBe(false);
  });

  it("resolves name, color, and text color for worktree branding", () => {
    const branding = getWorktreeUiBranding({
      PAPERCLIP_IN_WORKTREE: "true",
      PAPERCLIP_WORKTREE_NAME: "paperclip-pr-432",
      PAPERCLIP_WORKTREE_COLOR: "#4f86f7",
    });

    expect(branding.enabled).toBe(true);
    expect(branding.name).toBe("paperclip-pr-432");
    expect(branding.color).toBe("#4f86f7");
    expect(branding.textColor).toMatch(/^#[0-9a-f]{6}$/);
    expect(branding.faviconHref).toContain("data:image/svg+xml,");
  });

  it("renders a dynamic worktree favicon when enabled", () => {
    const links = renderFaviconLinks(
      getWorktreeUiBranding({
        PAPERCLIP_IN_WORKTREE: "true",
        PAPERCLIP_WORKTREE_NAME: "paperclip-pr-432",
        PAPERCLIP_WORKTREE_COLOR: "#4f86f7",
      }),
    );
    expect(links).toContain("data:image/svg+xml,");
    expect(links).toContain('rel="shortcut icon"');
  });

  it("draws the Myrmidon ant, not the vendor paperclip, in the worktree favicon", () => {
    const branding = getWorktreeUiBranding({
      PAPERCLIP_IN_WORKTREE: "true",
      PAPERCLIP_WORKTREE_COLOR: "#4f86f7",
    });
    const svg = decodeURIComponent((branding.faviconHref ?? "").replace("data:image/svg+xml,", ""));
    expect(svg).toContain("M386,330 C421,330"); // ant head
    expect(svg).not.toContain("m16 6-8.414 8.586"); // paperclip glyph
  });

  it("renders runtime branding metadata for the ui", () => {
    const meta = renderRuntimeBrandingMeta(
      getWorktreeUiBranding({
        PAPERCLIP_IN_WORKTREE: "true",
        PAPERCLIP_WORKTREE_NAME: "paperclip-pr-432",
        PAPERCLIP_WORKTREE_COLOR: "#4f86f7",
      }),
    );
    expect(meta).toContain('name="paperclip-worktree-name"');
    expect(meta).toContain('content="paperclip-pr-432"');
    expect(meta).toContain('name="paperclip-worktree-color"');
  });

  it("surfaces the runtime instance id so the UI can fail closed on copied rows", () => {
    const branding = getWorktreeUiBranding({
      PAPERCLIP_IN_WORKTREE: "true",
      PAPERCLIP_WORKTREE_NAME: "paperclip-pr-432",
      PAPERCLIP_WORKTREE_COLOR: "#4f86f7",
      PAPERCLIP_INSTANCE_ID: "inst-abc123",
    });
    expect(branding.instanceId).toBe("inst-abc123");

    const meta = renderRuntimeBrandingMeta(branding);
    expect(meta).toContain('name="paperclip-instance-id"');
    expect(meta).toContain('content="inst-abc123"');
  });

  it("omits the instance-id meta when the runtime id is unset", () => {
    const branding = getWorktreeUiBranding({
      PAPERCLIP_IN_WORKTREE: "true",
      PAPERCLIP_WORKTREE_NAME: "paperclip-pr-432",
      PAPERCLIP_WORKTREE_COLOR: "#4f86f7",
    });
    expect(branding.instanceId).toBeNull();
    expect(renderRuntimeBrandingMeta(branding)).not.toContain('name="paperclip-instance-id"');
  });

  it("rewrites the favicon and runtime branding blocks for worktree instances only", () => {
    const branded = applyUiBranding(TEMPLATE, {
      PAPERCLIP_IN_WORKTREE: "true",
      PAPERCLIP_WORKTREE_NAME: "paperclip-pr-432",
      PAPERCLIP_WORKTREE_COLOR: "#4f86f7",
    });
    expect(branded).toContain("data:image/svg+xml,");
    expect(branded).toContain('name="paperclip-worktree-name"');
    expect(branded).not.toContain('href="/favicon.svg"');

    const defaultHtml = applyUiBranding(TEMPLATE, {});
    expect(defaultHtml).toContain('href="/favicon.svg"');
    expect(defaultHtml).not.toContain('name="paperclip-worktree-name"');
  });
});
