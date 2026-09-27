import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  compileForbiddenPatterns,
  findPrivateIps,
  isTestPath,
  main,
  parseAddedLines,
  scan,
} from "./scan-diff.mjs";

// Addresses are assembled at runtime so this file does not trip the scanner itself.
const ip = (...octets) => octets.join(".");

function diff(file, lines, start = 1) {
  return [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -0,0 +${start},${lines.length} @@`,
    ...lines.map((l) => `+${l}`),
    "",
  ].join("\n");
}

function run(argv, env = {}) {
  const lines = [];
  const log = { log: (m) => lines.push(m), error: (m) => lines.push(m) };
  return { code: main(argv, env, log), output: lines.join("\n") };
}

function writeDiff(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scan-diff-"));
  const file = path.join(dir, "change.diff");
  fs.writeFileSync(file, text);
  return file;
}

describe("parseAddedLines", () => {
  it("tracks file names and new line numbers", () => {
    const text = [
      "diff --git a/a.txt b/a.txt",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -10,0 +11,2 @@",
      "+first",
      "+second",
      "diff --git a/gone.txt b/gone.txt",
      "--- a/gone.txt",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-removed",
    ].join("\n");
    assert.deepEqual(parseAddedLines(text), [
      { file: "a.txt", line: 11, text: "first" },
      { file: "a.txt", line: 12, text: "second" },
    ]);
  });
});

describe("findPrivateIps", () => {
  it("finds RFC 1918 and CGNAT addresses", () => {
    assert.deepEqual(findPrivateIps(`host ${ip(10, 1, 2, 3)}`), ["10/8"]);
    assert.deepEqual(findPrivateIps(`http://${ip(172, 20, 0, 5)}:8080`), ["172.16/12"]);
    assert.deepEqual(findPrivateIps(`${ip(192, 168, 1, 1)}/24`), ["192.168/16"]);
    assert.deepEqual(findPrivateIps(ip(100, 100, 1, 2)), ["100.64/10"]);
  });

  it("ignores public, documentation and loopback addresses", () => {
    assert.deepEqual(findPrivateIps(`${ip(192, 0, 2, 10)} ${ip(198, 51, 100, 7)} ${ip(127, 0, 0, 1)} ${ip(172, 32, 0, 1)}`), []);
  });

  it("ignores version strings and invalid octets", () => {
    assert.deepEqual(findPrivateIps(`v${ip(1, 10, 1, 2, 3)}`), []);
    assert.deepEqual(findPrivateIps(ip(10, 300, 1, 1)), []);
    assert.deepEqual(findPrivateIps("10.1.2"), []);
  });
});

describe("compileForbiddenPatterns", () => {
  it("skips blanks and comments and keeps line numbers", () => {
    const patterns = compileForbiddenPatterns("# comment\n\nexample-host\\.internal\ncorp[");
    assert.deepEqual(patterns.map((p) => p.number), [3, 4]);
    assert.ok(patterns[0].regex.test("see EXAMPLE-HOST.internal"));
    assert.ok(patterns[1].regex.test("corp["), "invalid regex falls back to a literal");
  });
});

describe("scan", () => {
  const added = parseAddedLines(
    diff("docs/a.md", [`ssh ${ip(10, 1, 2, 3)}`, "plain"]) + diff("server/src/__tests__/x.test.ts", [`const h = "${ip(10, 9, 9, 9)}";`]),
  );

  it("reports file, line and rule without the matched text", () => {
    const findings = scan(added, { check: "private-ip" });
    assert.deepEqual(findings, [
      { file: "docs/a.md", line: 1, rule: "private address in 10/8" },
      { file: "server/src/__tests__/x.test.ts", line: 1, rule: "private address in 10/8" },
    ]);
  });

  it("skips test paths only when asked", () => {
    const findings = scan(added, { check: "private-ip", skipTests: true });
    assert.deepEqual(findings.map((f) => f.file), ["docs/a.md"]);
  });

  it("honours the allowlist for the private-address check", () => {
    const allowlist = [{ path: "docs/**", reason: "fixture", regex: /^docs\/.*$/ }];
    const findings = scan(added, { check: "private-ip", allowlist });
    assert.deepEqual(findings.map((f) => f.file), ["server/src/__tests__/x.test.ts"]);
  });

  it("classifies test paths", () => {
    assert.ok(isTestPath("server/src/__tests__/a.ts"));
    assert.ok(isTestPath("ui/src/a.test.tsx"));
    assert.ok(isTestPath("tests/e2e/a.spec.ts"));
    assert.ok(!isTestPath("server/src/services/latest.ts"));
  });
});

describe("main", () => {
  it("fails on a private address and prints no address", () => {
    const file = writeDiff(diff("docs/example.md", [`Connect to ${ip(10, 1, 2, 3)}`]));
    const { code, output } = run(["--check", "private-ip", "--diff-file", file]);
    assert.equal(code, 1);
    assert.match(output, /::error file=docs\/example\.md,line=1::private address in 10\/8/);
    assert.ok(!output.includes(ip(10, 1, 2, 3)));
  });

  it("passes a clean diff", () => {
    const file = writeDiff(diff("docs/example.md", [`Use ${ip(192, 0, 2, 1)} in examples`]));
    assert.equal(run(["--check", "private-ip", "--diff-file", file]).code, 0);
  });

  it("warns and passes when forbidden patterns are not configured", () => {
    const file = writeDiff(diff("docs/example.md", ["anything"]));
    const { code, output } = run(["--check", "forbidden", "--diff-file", file], {});
    assert.equal(code, 0);
    assert.match(output, /::warning/);
  });

  it("fails on a forbidden pattern without revealing it", () => {
    const secretHost = ["corp", "example", "lan"].join("-");
    const file = writeDiff(diff("scripts/deploy.sh", [`HOST=${secretHost}`]));
    const { code, output } = run(["--check", "forbidden", "--diff-file", file], { MYRMIDON_FORBIDDEN_PATTERNS: `# ours\n${secretHost}` });
    assert.equal(code, 1);
    assert.match(output, /forbidden pattern #2/);
    assert.ok(!output.includes(secretHost));
  });

  it("rejects bad usage", () => {
    assert.equal(run(["--check", "nope", "--diff-file", "x"]).code, 2);
  });
});
