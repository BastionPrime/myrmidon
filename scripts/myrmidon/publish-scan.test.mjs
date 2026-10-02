import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { compileForbiddenPatterns } from "./scan-diff.mjs";
import { main, scanForPublication } from "./publish-scan.mjs";

// Tokens, addresses and the secret value are assembled at runtime from
// neutral placeholders so this test file does not trip the scanner itself.

const ip = (...octets) => octets.join(".");
const passwordPair = ["password", "hunter2"].join(": ");

function run(text, argv = [], env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "publish-scan-"));
  const file = path.join(dir, "body.md");
  fs.writeFileSync(file, text);
  const lines = [];
  const log = { log: (m) => lines.push(m), error: (m) => lines.push(m) };
  const code = main([...argv, "--file", file], env, log);
  return { code, output: lines.join("\n") };
}

function runArgs(argv, env = {}) {
  const lines = [];
  const log = { log: (m) => lines.push(m), error: (m) => lines.push(m) };
  const code = main(argv, env, log);
  return { code, output: lines.join("\n") };
}

// Forbidden patterns come from a private list, so the test uses neutral
// placeholders: the pattern line and the text it matches are made up here.
const forbiddenList = ["# comment line", "zzhost-\\d+"].join("\n");
const forbiddenHit = ["zzhost", "42"].join("-");

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

  it("applies forbidden patterns next to the built-in rules", () => {
    const forbidden = compileForbiddenPatterns(forbiddenList);
    const result = scanForPublication(`ok\nsee ${forbiddenHit}\n${passwordPair}`, forbidden);
    assert.equal(result.allowed, false);
    assert.deepEqual(result.byRule, [
      { rule: "forbidden pattern #2", count: 1 },
      { rule: "secret-like assignment", count: 1 },
    ]);
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

  it("exits 2 when --file has no value", () => {
    assert.equal(runArgs(["--file"]).code, 2);
    assert.equal(runArgs(["--file", ""]).code, 2);
  });

  it("exits 2 when the input cannot be read", () => {
    const { code, output } = runArgs(["--file", os.tmpdir()]);
    assert.equal(code, 2);
    assert.ok(!output.includes("publication allowed"));
  });

  it("exits 2 and never allows publication when stdin cannot be read", () => {
    // A directory as stdin makes the read fail; it must not look like empty clean text.
    const fd = fs.openSync(os.tmpdir(), "r");
    try {
      const script = fileURLToPath(new URL("./publish-scan.mjs", import.meta.url));
      const child = spawnSync(process.execPath, [script], { stdio: [fd, "pipe", "pipe"], encoding: "utf8" });
      assert.equal(child.status, 2);
      assert.ok(!child.stdout.includes("publication allowed"));
    } finally {
      fs.closeSync(fd);
    }
  });
});

describe("forbidden patterns", () => {
  it("refuses text matching a pattern from MYRMIDON_FORBIDDEN_PATTERNS and prints neither pattern nor match", () => {
    const { code, output } = run(`intro\nrolled out on ${forbiddenHit} today`, [], {
      MYRMIDON_FORBIDDEN_PATTERNS: forbiddenList,
    });
    assert.equal(code, 1);
    assert.match(output, /1 finding\(s\): forbidden pattern #2 x1/);
    assert.match(output, /publication refused/);
    assert.ok(!output.includes("zzhost"));
    assert.ok(!output.includes(forbiddenHit));
    assert.ok(!output.includes("warning"));
  });

  it("allows clean text when patterns are configured", () => {
    const { code, output } = run("Plain text without anything internal.", [], {
      MYRMIDON_FORBIDDEN_PATTERNS: forbiddenList,
    });
    assert.equal(code, 0);
    assert.ok(!output.includes("::warning"));
  });

  it("warns when no patterns are configured and still applies the built-in rules", () => {
    const clean = run("Plain text.");
    assert.equal(clean.code, 0);
    assert.match(clean.output, /::warning title=publish scan::MYRMIDON_FORBIDDEN_PATTERNS is not set/);
    const dirty = run(passwordPair);
    assert.equal(dirty.code, 1);
    assert.match(dirty.output, /::warning/);
  });
});
