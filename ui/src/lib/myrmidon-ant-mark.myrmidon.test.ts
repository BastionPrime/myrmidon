// myrmidon: one ant mark everywhere. Every SVG that draws the ant (logo lockups,
// loading mark, favicon, app icon, worktree favicon) and the server-side
// worktree favicon generator must use the identical stroke paths of
// brand/myrmidon/myrmidon-mark.svg; only colour, stroke width and the plate differ.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const UI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PUBLIC = path.join(UI_ROOT, "public");
const BRAND = path.join(PUBLIC, "brand", "myrmidon");
const UI_BRANDING_TS = path.resolve(UI_ROOT, "..", "server", "src", "ui-branding.ts");

function normalizeD(d: string): string {
  return d
    .replace(/[,\s]+/g, " ")
    .replace(/\s*([MLCZmlcz])\s*/g, "$1")
    .trim();
}

/** The ant is the group of stroked (fill="none") paths; the wordmark paths are filled and skipped. */
function antPaths(svg: string): string[] {
  const group = svg.match(/<g[^>]*fill="none"[^>]*>([\s\S]*?)<\/g>/);
  if (!group) throw new Error("no stroked ant group in svg");
  return [...group[1].matchAll(/<path[^>]*\sd="([^"]+)"/g)].map((m) => normalizeD(m[1]));
}

const read = (p: string) => readFileSync(p, "utf8");
const reference = antPaths(read(path.join(BRAND, "myrmidon-mark.svg")));

const SVG_FILES = [
  path.join(BRAND, "myrmidon-mark.svg"),
  path.join(BRAND, "myrmidon-mark-small.svg"),
  path.join(BRAND, "myrmidon-mark-white.svg"),
  path.join(BRAND, "myrmidon-lockup.svg"),
  path.join(BRAND, "myrmidon-lockup-white.svg"),
  path.join(BRAND, "myrmidon-app-icon.svg"),
  path.join(BRAND, "myrmidon-favicon.svg"),
  path.join(PUBLIC, "favicon.svg"),
  path.join(PUBLIC, "worktree-favicon.svg"),
];

describe("one ant mark", () => {
  it("the reference mark has the five stroked paths", () => {
    expect(reference).toHaveLength(5);
  });

  it.each(SVG_FILES.map((f) => [path.relative(UI_ROOT, f), f]))("%s draws the reference ant", (_name, file) => {
    expect(antPaths(read(file))).toEqual(reference);
  });

  it("the worktree favicon generator in the server uses the reference ant", () => {
    const src = read(UI_BRANDING_TS);
    const block = src.match(/ANT_STROKE_PATHS\s*=\s*\[([\s\S]*?)\];/);
    expect(block).not.toBeNull();
    const paths = [...block![1].matchAll(/"([^"]+)"/g)].map((m) => normalizeD(m[1]));
    expect(paths).toEqual(reference);
  });

  it("favicons are the bare mark on a transparent background, adaptive to the colour scheme", () => {
    for (const file of [path.join(BRAND, "myrmidon-favicon.svg"), path.join(PUBLIC, "favicon.svg"), path.join(PUBLIC, "worktree-favicon.svg")]) {
      const svg = read(file);
      expect(svg, file).not.toContain("<rect");
      expect(svg, file).toContain("prefers-color-scheme:dark");
    }
  });

  it("only the phone home-screen icon has a plate (white ant on navy)", () => {
    const appIcon = read(path.join(BRAND, "myrmidon-app-icon.svg"));
    expect(appIcon).toContain('<rect');
    expect(appIcon).toContain('fill="#13294B"');
    expect(appIcon).toContain('stroke="#FFFFFF"');
  });

  it("favicon.ico carries 16, 32 and 48 px layers", () => {
    for (const file of [path.join(PUBLIC, "favicon.ico"), path.join(BRAND, "favicon.ico")]) {
      const buf = readFileSync(file);
      const count = buf.readUInt16LE(4);
      const sizes = Array.from({ length: count }, (_, i) => buf[6 + i * 16] || 256).sort((a, b) => a - b);
      expect(sizes).toEqual([16, 32, 48]);
    }
  });
});
