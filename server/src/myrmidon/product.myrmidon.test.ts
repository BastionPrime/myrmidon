import { describe, expect, it } from "vitest";

import {
  PRODUCT_ATTRIBUTION,
  PRODUCT_NAME,
  productPossessive,
  productSaid,
} from "./product.js";
import { buildOpenApiSpec } from "../routes/openapi.js";
import {
  SUCCESSFUL_RUN_HANDOFF_EXHAUSTED_NOTICE_BODY,
  SUCCESSFUL_RUN_HANDOFF_REQUIRED_NOTICE_BODY,
} from "../services/recovery/successful-run-handoff.js";

// myrmidon(B1): guard against the product re-introducing "Paperclip" as its
// own name in the surfaces this track renamed. Attribution ("Based on
// Paperclip (MIT)") is the one allowed exception (see NOTICE).
describe("product naming", () => {
  it("names the product Myrmidon", () => {
    expect(PRODUCT_NAME).toBe("Myrmidon");
    expect(PRODUCT_ATTRIBUTION).toBe("Based on Paperclip (MIT)");
  });

  it("builds sentence-leading and possessive mentions", () => {
    expect(productSaid("needs a disposition.")).toBe("Myrmidon needs a disposition.");
    expect(productPossessive("task")).toBe("Myrmidon's task");
  });

  // The shared notice bodies (packages/shared) carry the product name as a
  // literal because that package cannot import this module. This ties the two.
  it("keeps the shared handoff notice bodies in step with the product name", () => {
    expect(SUCCESSFUL_RUN_HANDOFF_REQUIRED_NOTICE_BODY).toBe(
      productSaid("needs a disposition before this issue can continue."),
    );
    expect(SUCCESSFUL_RUN_HANDOFF_EXHAUSTED_NOTICE_BODY).toBe(
      productSaid(
        "could not resolve this issue's missing disposition automatically. The source assignment is unchanged and a board decision is required.",
      ),
    );
  });

  it("titles the OpenAPI document Myrmidon, attributed to Paperclip", () => {
    const doc = buildOpenApiSpec();
    expect(doc.info.title).toBe("Myrmidon API");
    expect(doc.info.title).not.toMatch(/Paperclip/);
    expect(doc.info.description).toContain("Myrmidon");
    expect(doc.info.description).toContain(PRODUCT_ATTRIBUTION);
  });
});
