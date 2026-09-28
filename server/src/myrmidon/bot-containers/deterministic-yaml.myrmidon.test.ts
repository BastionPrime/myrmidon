import { describe, expect, it } from "vitest";

import { writeYamlDocument } from "./deterministic-yaml.js";

describe("myrmidon(G2) writeYamlDocument", () => {
  it("sorts mapping keys at every level", () => {
    const out = writeYamlDocument({
      zebra: "z",
      alpha: { delta: "d", bravo: "b" },
    });
    expect(out).toBe('alpha:\n  bravo: "b"\n  delta: "d"\nzebra: "z"\n');
  });

  it("always double-quotes string scalars, even ones that look like YAML booleans or null", () => {
    // Regression: PyYAML's default (YAML 1.1) loader reads unquoted off/on/yes/no
    // as booleans and ~/null as null. Every string here must round-trip as a
    // string, never silently become a boolean or null on the Hermes side.
    const out = writeYamlDocument({
      a: "off",
      b: "on",
      c: "yes",
      d: "no",
      e: "null",
      f: "~",
      g: "true",
      h: "false",
    });
    for (const line of out.trim().split("\n")) {
      expect(line).toMatch(/^[a-h]: "[a-z~]+"$/);
    }
  });

  it("renders real boolean and number scalars unquoted", () => {
    const out = writeYamlDocument({ enabled: true, disabled: false, count: 12, ratio: 0.2 });
    expect(out).toBe("count: 12\ndisabled: false\nenabled: true\nratio: 0.2\n");
  });

  it("drops keys whose value is undefined", () => {
    const out = writeYamlDocument({ a: "kept", b: undefined });
    expect(out).toBe('a: "kept"\n');
  });

  it("drops a nested mapping entirely when every one of its fields is undefined", () => {
    const out = writeYamlDocument({ agent: { reasoning_effort: undefined }, kept: "x" });
    expect(out).toBe('kept: "x"\n');
  });

  it("drops an empty array entirely rather than writing `key: []`", () => {
    const out = writeYamlDocument({ list: [], kept: "x" });
    expect(out).toBe('kept: "x"\n');
  });

  it("renders a block sequence of scalars at the key's own indent", () => {
    const out = writeYamlDocument({ toolsets: ["terminal", "file", "web"] });
    expect(out).toBe('toolsets:\n- "terminal"\n- "file"\n- "web"\n');
  });

  it("renders a block sequence of flat mappings with continuation keys aligned under the first", () => {
    const out = writeYamlDocument({
      fallback_model: [
        { provider: "xai", model: "grok-4" },
        { provider: "xai", model: "grok-3" },
      ],
    });
    expect(out).toBe(
      'fallback_model:\n- model: "grok-4"\n  provider: "xai"\n- model: "grok-3"\n  provider: "xai"\n',
    );
  });

  it("nests a mapping inside a mapping inside a mapping without losing indentation", () => {
    const out = writeYamlDocument({
      mcp_servers: { ragflow: { url: "https://example.com/mcp", headers: { "X-Token": "t" } } },
    });
    // "X-Token" is a safe bare YAML key (letters, digits, "-", "." and "_" are
    // all plain-scalar safe as long as the key doesn't start with one of them).
    expect(out).toBe(
      'mcp_servers:\n  ragflow:\n    headers:\n      X-Token: "t"\n    url: "https://example.com/mcp"\n',
    );
  });

  it("quotes a mapping key that is not a safe bare identifier", () => {
    const out = writeYamlDocument({ "123start": "p", "has space": "t" });
    expect(out).toBe('"123start": "p"\n"has space": "t"\n');
  });

  it("is deterministic across repeated calls with the same logical input", () => {
    const build = () => ({
      c: "3",
      a: { z: "1", y: ["b", "a"] },
      b: undefined,
    });
    expect(writeYamlDocument(build())).toBe(writeYamlDocument(build()));
  });

  it("returns an empty string for a document with no defined keys", () => {
    expect(writeYamlDocument({ a: undefined })).toBe("");
  });

  it("throws rather than silently render a non-finite number", () => {
    expect(() => writeYamlDocument({ a: Number.NaN })).toThrow();
    expect(() => writeYamlDocument({ a: Number.POSITIVE_INFINITY })).toThrow();
  });

  it("throws rather than silently render a nested sequence", () => {
    expect(() => writeYamlDocument({ a: [["nested"]] })).toThrow();
  });
});
