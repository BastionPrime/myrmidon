import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  classifyLicense,
  evaluate,
  main,
  parseLicenseExpression,
  validatePolicy,
} from "./check-licenses.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "fixtures");
const TEST_POLICY = path.join(FIXTURES, "license-policy.test.json");
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

function silentLog() {
  const lines = [];
  return { lines, log: (m) => lines.push(m), error: (m) => lines.push(m) };
}

describe("parseLicenseExpression", () => {
  it("splits OR alternatives and AND conjunctions", () => {
    assert.deepEqual(parseLicenseExpression("(MIT OR Apache-2.0)"), [["MIT"], ["Apache-2.0"]]);
    assert.deepEqual(parseLicenseExpression("Apache-2.0 AND BSD-3-Clause"), [["Apache-2.0", "BSD-3-Clause"]]);
  });

  it("rejects free text", () => {
    assert.equal(parseLicenseExpression("SEE LICENSE IN LICENSE.md"), null);
    assert.equal(parseLicenseExpression(""), null);
    assert.equal(parseLicenseExpression("MIT OR"), null);
  });
});

describe("classifyLicense", () => {
  const policy = readJson(TEST_POLICY);

  it("allows listed licenses case-insensitively", () => {
    assert.equal(classifyLicense("MIT", policy), "allowed");
    assert.equal(classifyLicense("apache-2.0", policy), "allowed");
  });

  it("allows an OR expression when one side is allowed", () => {
    assert.equal(classifyLicense("(GPL-3.0-only OR MIT)", policy), "allowed");
  });

  it("forbids GPL family, unknown and AND with a forbidden part", () => {
    assert.equal(classifyLicense("GPL-3.0-only", policy), "forbidden");
    assert.equal(classifyLicense("AGPL-3.0-or-later", policy), "forbidden");
    assert.equal(classifyLicense("SSPL-1.0", policy), "forbidden");
    assert.equal(classifyLicense("Unknown", policy), "forbidden");
    assert.equal(classifyLicense("MIT AND GPL-2.0-only", policy), "forbidden");
  });

  it("treats unlisted licenses and free text as not allowed", () => {
    assert.equal(classifyLicense("MPL-2.0", policy), "unknown");
    assert.equal(classifyLicense("SEE LICENSE IN LICENSE.md", policy), "unknown");
  });
});

describe("evaluate", () => {
  const policy = readJson(TEST_POLICY);

  it("passes a clean report and reports exceptions", () => {
    const result = evaluate(readJson(path.join(FIXTURES, "licenses-clean.json")), {
      ...policy,
      allowed: [...policy.allowed, "MPL-2.0"],
    });
    assert.deepEqual(result.violations, []);
    assert.deepEqual(result.excepted.map((e) => e.name), ["pkg-excepted"]);
    assert.deepEqual(result.unusedExceptions.map((e) => e.name), ["pkg-gone"]);
  });

  it("flags a forbidden license", () => {
    const result = evaluate(readJson(path.join(FIXTURES, "licenses-forbidden.json")), policy);
    assert.deepEqual(result.violations, [
      { name: "pkg-gpl", version: "1.2.3", license: "GPL-3.0-only", verdict: "forbidden" },
    ]);
  });

  it("does not apply an exception when the reported license changes", () => {
    const report = { MIT: [{ name: "pkg-excepted", versions: ["6.0.0"], license: "GPL-3.0-only" }] };
    const result = evaluate(report, policy);
    assert.equal(result.violations.length, 1);
  });
});

describe("validatePolicy", () => {
  it("requires a reason on every exception", () => {
    const problems = validatePolicy({ allowed: ["MIT"], forbidden: [], exceptions: [{ name: "x", license: "Unknown" }] });
    assert.equal(problems.length, 1);
  });

  it("accepts the repository policy", () => {
    assert.deepEqual(validatePolicy(readJson(path.join(HERE, "license-policy.json"))), []);
  });
});

describe("main", () => {
  it("exits 1 on a forbidden license in the report", () => {
    const out = silentLog();
    const code = main(["--input", path.join(FIXTURES, "licenses-forbidden.json"), "--policy", TEST_POLICY], out);
    assert.equal(code, 1);
    assert.ok(out.lines.some((l) => l.includes("FORBIDDEN: pkg-gpl@1.2.3")));
  });

  it("exits 0 on a clean report", () => {
    const out = silentLog();
    const code = main(["--input", path.join(FIXTURES, "licenses-clean.json"), "--policy", TEST_POLICY], out);
    // pkg-dual (MPL-2.0 OR Apache-2.0) is allowed through Apache-2.0.
    assert.equal(code, 0, out.lines.join("\n"));
  });
});
