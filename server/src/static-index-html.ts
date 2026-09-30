import fs from "node:fs";
import path from "node:path";
import { injectCloudUiSnippet } from "./cloud-ui-snippet.js";
import { applyUiBranding, resolveIconVersion, versionIconUrl } from "./ui-branding.js";

export function readBrandedStaticIndexHtml(uiDist: string): string {
  return injectCloudUiSnippet(applyUiBranding(fs.readFileSync(path.join(uiDist, "index.html"), "utf-8")));
}

/** The web manifest with icon URLs versioned like the ones in index.html. */
export function readVersionedWebManifest(uiDist: string, version: string | null = resolveIconVersion()): string {
  const raw = fs.readFileSync(path.join(uiDist, "site.webmanifest"), "utf-8");
  if (!version) return raw;
  const manifest = JSON.parse(raw) as { icons?: Array<{ src?: string }> };
  for (const icon of manifest.icons ?? []) {
    if (typeof icon.src === "string") icon.src = versionIconUrl(icon.src, version);
  }
  return JSON.stringify(manifest, null, 2);
}
