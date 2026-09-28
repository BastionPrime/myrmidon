// myrmidon(B1): single source of truth for the product name shown to people
// and agents in server-generated text (task comments, chat/webhook messages,
// the OpenAPI document). Do not hardcode "Myrmidon" or "Paperclip" in new
// user-facing strings; import PRODUCT_NAME (or a helper below) instead.
//
// This does not rename package names (@paperclipai/*), environment variables
// (PAPERCLIP_*), the paperclipai CLI, API paths, HTTP headers, log messages,
// or database identifiers — those stay untouched for vendor compatibility
// (see NOTICE and docs/myrmidon/CONVENTIONS.md §8).

/** The product name as shown to people and agents. */
export const PRODUCT_NAME = "Myrmidon";

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
