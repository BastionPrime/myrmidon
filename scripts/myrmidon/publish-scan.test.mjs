import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { main, scanForPublication } from "./publish-scan.mjs";

// Tokens, addresses and the secret value are assembled at runtime from
// neutral placeholders so this test file does not trip the scanner itself.

const ip = (...octets) => octets.join(".");
const passwordPair = ["password", "hunter2"].join(": ");

function run(text, argv = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "publish-scan-"));
  const file = path.join(dir, "body.md");
  fs.writeFileSync(file, text);
  const lines = [];
  const log = { log: (m) => lines.push(m), error: (m) => lines.push(m) };
  const code = main([...argv, "--file", file], {}, log);
  return { code, output: lines.join("\n") };
}

describe("scanForPublication", () => {
  it("allows clean text", () => {
    const result = scanForPublication("A PR body that mentions example.com only.");
    assert.deepEqual(result, { allowed: true, lines: 1, findingCount: 0, byRule: [] });
  });

  it("refuses text with a secret and counts findings by rule", () => {
    const result = scanForPublication(`one\n${passwordPair}\nhost ${ip(10, 10, 10, 4)}`);
    assert.equal(result.allowed, false);
    assert.equal(result.findingCount, 2);
    assert.deepEqual(result.byRule, [
      { rule: "secret-like assignment", count: 1 },
      { rule: "private address in 10/8", count: 1 },
    ]);
  });

  it("handles empty text", () => {
    assert.deepEqual(scanForPublication(""), { allowed: true, lines: 0, findingCount: 0, byRule: [] });
  });
});

describe("main", () => {
  it("exits 0 on clean text", () => {
    const { code, output } = run("Refactors the intake flow. Use example.com in docs.");
    assert.equal(code, 0);
    assert.match(output, /scanned 1 line\(s\)/);
    assert.match(output, /no findings/);
    assert.match(output, /publication allowed/);
  });

  it("exits 1 on a secret and never prints the value", () => {
    const { code, output } = run(`before\n${passwordPair}\nafter`);
    assert.equal(code, 1);
    assert.match(output, /1 finding\(s\): secret-like assignment x1/);
    assert.ok(!output.includes("hunter2"));
    assert.match(output, /publication refused/);
  });

  it("exits 1 on an internal address and never prints it", () => {
    const { code, output } = run(`deploy at ${ip(192, 168, 1, 5)}`);
    assert.equal(code, 1);
    assert.match(output, /private address in 192\.168\/16 x1/);
    assert.ok(!output.includes(ip(192, 168, 1, 5)));
  });

  it("exits 1 on a token prefix and never prints it", () => {
    const token = ["github_pat", "XXX"].join("_");
    const { code, output } = run(`uses ${token}`);
    assert.equal(code, 1);
    assert.match(output, /github token x1/);
    assert.ok(!output.includes(token));
  });

  it("exits 2 on a missing file", () => {
    const lines = [];
    const log = { log: (m) => lines.push(m), error: (m) => lines.push(m) };
    assert.equal(main(["--file", "/nonexistent/missing.md"], {}, log), 2);
  });

  it("exits 2 on an unknown argument", () => {
    const lines = [];
    const log = { log: (m) => lines.push(m), error: (m) => lines.push(m) };
    assert.equal(main(["--nope"], {}, log), 2);
  });
});
