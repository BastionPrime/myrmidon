const FAVICON_BLOCK_START = "<!-- PAPERCLIP_FAVICON_START -->";
const FAVICON_BLOCK_END = "<!-- PAPERCLIP_FAVICON_END -->";
const RUNTIME_BRANDING_BLOCK_START = "<!-- PAPERCLIP_RUNTIME_BRANDING_START -->";
const RUNTIME_BRANDING_BLOCK_END = "<!-- PAPERCLIP_RUNTIME_BRANDING_END -->";

import { readBuildVersion } from "./build-version.js";

const DEFAULT_FAVICON_LINKS = [
  '<link rel="icon" href="/favicon.ico" sizes="48x48" />',
  '<link rel="icon" href="/favicon.svg" type="image/svg+xml" />',
  '<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png" />',
  '<link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png" />',
].join("\n");

export type WorktreeUiBranding = {
  enabled: boolean;
  name: string | null;
  color: string | null;
  textColor: string | null;
  faviconHref: string | null;
  /**
   * Runtime instance id for this worktree preview. Surfaced to the client so
   * the experimental "Run tasks in this worktree" card can fail closed when a
   * copied settings row was armed in a different instance. Null outside a
   * worktree or when the runtime id is unset.
   */
  instanceId: string | null;
};

function isTruthyEnvValue(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function nonEmpty(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeHexColor(value: string | undefined): string | null {
  const raw = nonEmpty(value);
  if (!raw) return null;
  const hex = raw.startsWith("#") ? raw.slice(1) : raw;
  if (/^[0-9a-fA-F]{3}$/.test(hex)) {
    return `#${hex.split("").map((char) => `${char}${char}`).join("").toLowerCase()}`;
  }
  if (/^[0-9a-fA-F]{6}$/.test(hex)) {
    return `#${hex.toLowerCase()}`;
  }
  return null;
}

function hslComponentToHex(n: number): string {
  return Math.round(Math.max(0, Math.min(255, n)))
    .toString(16)
    .padStart(2, "0");
}

function hslToHex(hue: number, saturation: number, lightness: number): string {
  const s = Math.max(0, Math.min(100, saturation)) / 100;
  const l = Math.max(0, Math.min(100, lightness)) / 100;
  const c = (1 - Math.abs((2 * l) - 1)) * s;
  const h = ((hue % 360) + 360) % 360;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - (c / 2);

  let r = 0;
  let g = 0;
  let b = 0;

  if (h < 60) {
    r = c;
    g = x;
  } else if (h < 120) {
    r = x;
    g = c;
  } else if (h < 180) {
    g = c;
    b = x;
  } else if (h < 240) {
    g = x;
    b = c;
  } else if (h < 300) {
    r = x;
    b = c;
  } else {
    r = c;
    b = x;
  }

  return `#${hslComponentToHex((r + m) * 255)}${hslComponentToHex((g + m) * 255)}${hslComponentToHex((b + m) * 255)}`;
}

function deriveColorFromSeed(seed: string): string {
  let hash = 0;
  for (const char of seed) {
    hash = ((hash * 33) + char.charCodeAt(0)) >>> 0;
  }
  return hslToHex(hash % 360, 68, 56);
}

function hexToRgb(color: string): { r: number; g: number; b: number } {
  const normalized = normalizeHexColor(color) ?? "#000000";
  return {
    r: Number.parseInt(normalized.slice(1, 3), 16),
    g: Number.parseInt(normalized.slice(3, 5), 16),
    b: Number.parseInt(normalized.slice(5, 7), 16),
  };
}

function relativeLuminanceChannel(value: number): number {
  const normalized = value / 255;
  return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(color: string): number {
  const { r, g, b } = hexToRgb(color);
  return (
    (0.2126 * relativeLuminanceChannel(r)) +
    (0.7152 * relativeLuminanceChannel(g)) +
    (0.0722 * relativeLuminanceChannel(b))
  );
}

function pickReadableTextColor(background: string): string {
  const backgroundLuminance = relativeLuminance(background);
  const whiteContrast = 1.05 / (backgroundLuminance + 0.05);
  const blackContrast = (backgroundLuminance + 0.05) / 0.05;
  return whiteContrast >= blackContrast ? "#f8fafc" : "#111827";
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

// The Myrmidon ant mark (same geometry as ui/public/brand/myrmidon/myrmidon-favicon.svg),
// on a transparent background, stroked in the worktree colour: the only difference
// from the regular favicon is the colour.
const ANT_VIEW_BOX = "66.8511 226.851 638.298 638.298";
const ANT_STROKE_PATHS = [
  "M346,516 L246,470 L263,392 L227,361 M426,516 L526,470 L509,392 L545,361 M351,564 L254,531 L204,622 L170,622 M421,564 L518,531 L568,622 L602,622 M360,603 L264,634 L208,818 L170,818 M412,603 L508,634 L564,818 L602,818",
  "M287,268 L386,414 L485,268",
  "M386,330 C421,330 445,357 452,391 C457,417 447,435 426,447 L386,472 L346,447 C325,435 315,417 320,391 C327,357 351,330 386,330 Z",
  "M386,466 L421,497 C428,503 431,512 429,521 L417,589 C415,599 409,607 401,613 L386,628 L371,613 C363,607 357,599 355,589 L343,521 C341,512 344,503 351,497 Z",
  "M386,620 L437,654 C455,666 463,688 459,712 C453,749 426,795 405,817 C399,823 393,826 386,826 C379,826 373,823 367,817 C346,795 319,749 313,712 C309,688 317,666 335,654 Z",
];

function createFaviconDataUrl(color: string): string {
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${ANT_VIEW_BOX}" width="32" height="32">`,
    `<g fill="none" stroke="${color}" stroke-width="30" stroke-linecap="round" stroke-linejoin="round">`,
    ...ANT_STROKE_PATHS.map((d) => `<path d="${d}"/>`),
    "</g>",
    "</svg>",
  ].join("");
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export function isWorktreeUiBrandingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isTruthyEnvValue(env.PAPERCLIP_IN_WORKTREE);
}

export function getWorktreeUiBranding(env: NodeJS.ProcessEnv = process.env): WorktreeUiBranding {
  if (!isWorktreeUiBrandingEnabled(env)) {
    return {
      enabled: false,
      name: null,
      color: null,
      textColor: null,
      faviconHref: null,
      instanceId: null,
    };
  }

  const name = nonEmpty(env.PAPERCLIP_WORKTREE_NAME) ?? nonEmpty(env.PAPERCLIP_INSTANCE_ID) ?? "worktree";
  const color = normalizeHexColor(env.PAPERCLIP_WORKTREE_COLOR) ?? deriveColorFromSeed(name);
  const textColor = pickReadableTextColor(color);

  return {
    enabled: true,
    name,
    color,
    textColor,
    faviconHref: createFaviconDataUrl(color),
    instanceId: nonEmpty(env.PAPERCLIP_INSTANCE_ID),
  };
}

/**
 * Build version used to bust browser icon caches. Some browsers keep favicons
 * in a separate store keyed by URL and ignore Cache-Control, so the only
 * reliable refresh is a different URL after every release.
 */
export function resolveIconVersion(env: NodeJS.ProcessEnv = process.env): string | null {
  return readBuildVersion({ environmentVersion: env.PAPERCLIP_BUILD_VERSION ?? null });
}

const ICON_URL_PATTERN = /^\/(?:favicon[\w.-]*\.(?:ico|svg|png)|apple-touch-icon\.png|android-chrome-[\w-]+\.png|site\.webmanifest)$/;

/** Appends `?v=<version>` to a same-origin icon/manifest URL; other URLs pass through. */
export function versionIconUrl(url: string, version: string | null): string {
  if (!version || !ICON_URL_PATTERN.test(url)) return url;
  return `${url}?v=${encodeURIComponent(version)}`;
}

/** Versions every icon/manifest href in an HTML document. */
export function applyIconVersionToHtml(html: string, version: string | null): string {
  if (!version) return html;
  return html.replace(/(\bhref=")([^"]+)(")/g, (_m, a: string, url: string, c: string) => `${a}${versionIconUrl(url, version)}${c}`);
}

export function renderFaviconLinks(branding: WorktreeUiBranding, version: string | null = null): string {
  if (!branding.enabled || !branding.faviconHref) return applyIconVersionToHtml(DEFAULT_FAVICON_LINKS, version);

  const href = escapeHtmlAttribute(branding.faviconHref);
  return [
    `<link rel="icon" href="${href}" type="image/svg+xml" sizes="any" />`,
    `<link rel="shortcut icon" href="${href}" type="image/svg+xml" />`,
  ].join("\n");
}

export function renderRuntimeBrandingMeta(branding: WorktreeUiBranding): string {
  if (!branding.enabled || !branding.name || !branding.color || !branding.textColor) return "";

  const tags = [
    '<meta name="paperclip-worktree-enabled" content="true" />',
    `<meta name="paperclip-worktree-name" content="${escapeHtmlAttribute(branding.name)}" />`,
    `<meta name="paperclip-worktree-color" content="${escapeHtmlAttribute(branding.color)}" />`,
    `<meta name="paperclip-worktree-text-color" content="${escapeHtmlAttribute(branding.textColor)}" />`,
  ];
  if (branding.instanceId) {
    tags.push(`<meta name="paperclip-instance-id" content="${escapeHtmlAttribute(branding.instanceId)}" />`);
  }
  return tags.join("\n");
}

function replaceMarkedBlock(html: string, startMarker: string, endMarker: string, content: string): string {
  const start = html.indexOf(startMarker);
  const end = html.indexOf(endMarker);
  if (start === -1 || end === -1 || end < start) return html;

  const before = html.slice(0, start + startMarker.length);
  const after = html.slice(end);
  const indentedContent = content
    ? `\n${content
      .split("\n")
      .map((line) => `    ${line}`)
      .join("\n")}\n    `
    : "\n    ";
  return `${before}${indentedContent}${after}`;
}

export function applyUiBranding(html: string, env: NodeJS.ProcessEnv = process.env): string {
  const branding = getWorktreeUiBranding(env);
  const version = resolveIconVersion(env);
  const withFavicon = replaceMarkedBlock(
    html,
    FAVICON_BLOCK_START,
    FAVICON_BLOCK_END,
    renderFaviconLinks(branding, version),
  );
  const branded = replaceMarkedBlock(
    withFavicon,
    RUNTIME_BRANDING_BLOCK_START,
    RUNTIME_BRANDING_BLOCK_END,
    renderRuntimeBrandingMeta(branding),
  );
  // Links outside the marked block (apple-touch-icon, manifest) get the same version.
  return applyIconVersionToHtml(branded, version);
}
