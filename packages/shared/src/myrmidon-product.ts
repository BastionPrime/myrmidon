// myrmidon(B1c): single source of truth for the product name, shared across
// workspace packages. server/src/myrmidon/product.ts re-exports this module so
// the server keeps its import paths; adapter-utils and other shared packages
// import the name from here without reaching into server-only code.
//
// This does not rename package names (@paperclipai/*), environment variables
// (PAPERCLIP_*), the paperclipai CLI, API paths, HTTP headers, log messages,
// or database identifiers — those stay untouched for vendor compatibility
// (see NOTICE and docs/myrmidon/CONVENTIONS.md §8).

/** The product name as shown to people and agents. */
export const PRODUCT_NAME = "Myrmidon";
