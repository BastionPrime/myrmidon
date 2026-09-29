import { describe, expect, it } from "vitest";
import {
  cloudConnectorEnrollmentOutcomeHtml,
  connectionIntentOAuthOutcomeHtml,
} from "./tool-access.js";

// B1b: the OAuth return page names the product. The Cloud enrollment page is a
// separate surface and is intentionally left as shipped.
describe("connection authorization return page (B1b)", () => {
  it("names the product while the window closes itself", () => {
    const html = connectionIntentOAuthOutcomeHtml({
      interactionId: "interaction-1",
      issueId: null,
      outcome: "connected",
    });
    expect(html).toContain("<p>Returning to Myrmidon…</p>");
    expect(html).not.toContain("Returning to Paperclip");
  });

  it("leaves the Cloud enrollment page as shipped", () => {
    const html = cloudConnectorEnrollmentOutcomeHtml("PRE", "/apps/connect");
    expect(html).toContain("Paperclip connected");
  });
});
