import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// B1b: the names of the built-in MCP servers are identifiers, not display text.
// Adapters use them as the MCP config key, the tool-name prefix and part of the
// session identity, so renaming them resets every resumable agent session once.
// The branding pass must leave them alone.
describe("built-in MCP server names stay vendor identifiers (B1b)", () => {
  const source = readFileSync(new URL("./heartbeat.ts", import.meta.url), "utf8");

  it("keeps the connections and projects server names", () => {
    expect(source).toContain('name: "Paperclip connections"');
    expect(source).toContain('name: "Paperclip projects"');
  });

  it("does not introduce branded variants of them", () => {
    expect(source).not.toMatch(/name:\s*["'`]Myrmidon (connections|projects)/);
    expect(source).not.toMatch(/name:\s*`\$\{PRODUCT_NAME\} (connections|projects)/);
    expect(source).not.toMatch(/productSaid\(\s*["'`](connections|projects)/);
  });
});
