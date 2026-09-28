import { describe, expect, it } from "vitest";

import {
  PRODUCT_ATTRIBUTION,
  PRODUCT_NAME,
  productPossessive,
  productSaid,
} from "./product.js";
import { buildOpenApiSpec } from "../routes/openapi.js";

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

  it("titles the OpenAPI document Myrmidon, attributed to Paperclip", () => {
    const doc = buildOpenApiSpec();
    expect(doc.info.title).toBe("Myrmidon API");
    expect(doc.info.title).not.toMatch(/Paperclip/);
    expect(doc.info.description).toContain("Myrmidon");
    expect(doc.info.description).toContain(PRODUCT_ATTRIBUTION);
  });
});
