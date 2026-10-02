import path from "node:path";

// Brand icons and the manifest: browsers pin tab icons hard, so a stale
// copy keeps showing the old logo. Revalidate (cheap 304) instead of a TTL.
const REVALIDATED_BRAND_FILES = new Set([
  "favicon.ico",
  "favicon.svg",
  "favicon-16x16.png",
  "favicon-32x32.png",
  "apple-touch-icon.png",
  "android-chrome-192x192.png",
  "android-chrome-512x512.png",
  "site.webmanifest",
]);

/**
 * Cache-Control override for non-hashed UI static files (everything outside
 * /assets, which is content-hashed and immutable). Two files must always be
 * revalidated:
 *
 * - `index.html` must never outlive the asset hashes it points at.
 * - `sw.js` is the browser's only channel for updating an installed service
 *   worker: clients re-fetch this exact URL to discover new worker code, so
 *   any cache TTL here delays every client's update by that long on top of
 *   the browser's own update timer.
 *
 * - The tab/app icons and the manifest (see REVALIDATED_BRAND_FILES).
 *
 * Returns undefined for files where the middleware's default TTL applies.
 */
export function staticUiCacheControl(filePath: string): "no-cache" | undefined {
  const basename = path.basename(filePath);
  return basename === "index.html" || basename === "sw.js" || REVALIDATED_BRAND_FILES.has(basename)
    ? "no-cache"
    : undefined;
}
