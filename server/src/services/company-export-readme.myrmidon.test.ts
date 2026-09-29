import { describe, expect, it } from "vitest";

import { generateReadme } from "./company-export-readme.js";

// myrmidon(B1): the exported company README names the product and carries
// Paperclip MIT attribution instead of presenting itself as Paperclip.
describe("generateReadme product branding", () => {
  it("names Myrmidon and attributes Paperclip under MIT, without presenting as Paperclip", () => {
    const readme = generateReadme(
      {
        agents: [],
        projects: [],
        skills: [],
        issues: [],
      } as never,
      { companyName: "Acme Co", companyDescription: null },
    );

    expect(readme).toContain("Myrmidon");
    expect(readme).toContain("Based on Paperclip (MIT)");
    expect(readme).not.toMatch(/package from Paperclip/);
    expect(readme).not.toMatch(/Exported from Paperclip/);
  });
});
