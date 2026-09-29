// myrmidon(B1a): single source of truth for the product name shown in the UI.
// Vendor identifiers (PAPERCLIP_*, @paperclipai/*, API paths, CSS classes,
// localStorage keys) are unaffected — only human-visible copy uses this.
export const PRODUCT_NAME = "Myrmidon";

/** MIT attribution shown on the instance "About" section. Do not remove: see docs/myrmidon/CONVENTIONS.md #9. */
export const UPSTREAM_ATTRIBUTION = {
  text: "Based on Paperclip (MIT)",
  href: "https://github.com/paperclipai/paperclip",
} as const;
