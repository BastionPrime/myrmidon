// myrmidon(B1): single source of truth for the product name shown to people
// and agents in server-generated text (task comments, chat/webhook messages,
// the OpenAPI document). Do not hardcode "Myrmidon" or "Paperclip" in new
// user-facing strings; import PRODUCT_NAME (or a helper below) instead.
//
// myrmidon(B1c): the constant itself moved to packages/shared
// (myrmidon-product.ts) so non-server packages can share it; this module
// re-exports it and keeps the server-side helpers.
//
// This does not rename package names (@paperclipai/*), environment variables
// (PAPERCLIP_*), the paperclipai CLI, API paths, HTTP headers, log messages,
// or database identifiers — those stay untouched for vendor compatibility
// (see NOTICE and docs/myrmidon/CONVENTIONS.md §8).

import { PRODUCT_NAME } from "@paperclipai/shared/myrmidon-product";

export { PRODUCT_NAME };

/** Short attribution line for "About" surfaces and generated documents. */
export const PRODUCT_ATTRIBUTION = `Based on Paperclip (MIT)`;

/**
 * Builds a sentence-leading mention of the product, e.g.
 * `productSaid("could not import this attachment")` ->
 * `"Myrmidon could not import this attachment"`.
 */
export function productSaid(rest: string): string {
  return `${PRODUCT_NAME} ${rest}`;
}

/** Builds a possessive mention, e.g. `productPossessive("task")` -> `"Myrmidon's task"`. */
export function productPossessive(noun: string): string {
  return `${PRODUCT_NAME}'s ${noun}`;
}
