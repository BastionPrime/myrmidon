import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { main, scanLine, scanText, summarizeFindings } from "./scan-text.mjs";

// Tokens and addresses are assembled at runtime and built from neutral
// placeholders so this test file does not trip the scanner itself.

const ip = (...octets) => octets.join(".");
const passwordPair = ["password", "hunter2"].join(": ");

function run(text, argv = [], env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scan-text-"));
  const file = path.join(dir, "input.txt");
  fs.writeFileSync(file, text);
  const lines = [];
  const log = { log: (m) => lines.push(m), error: (m) => lines.push(m) };
  const code = main([...argv, "--file", file], env, log);
  return { code, output: lines.join("\n") };
}

describe("scanText", () => {
  it("passes clean text", () => {
    assert.deepEqual(
      scanText("Nothing here.\nUse example.com and 192.0.2.10 in examples."),
      [],
    );
  });

  it("finds a password assignment without keeping the value", () => {
    const findings = scanText(`one\n${passwordPair}\nthree`);
    assert.deepEqual(findings, [{ line: 2, rule: "secret-like assignment" }]);
    assert.ok(!JSON.stringify(findings).includes("hunter2"));
  });

  it("finds an internal address", () => {
    const findings = scanText(`host ${ip(10, 10, 10, 4)}`);
    assert.deepEqual(findings, [{ line: 1, rule: "private address in 10/8" }]);
  });

  it("finds all RFC 1918 and CGNAT ranges and skips documentation ranges", () => {
    assert.deepEqual(
      scanText([
        `a ${ip(10, 1, 2, 3)}`,
        `b ${ip(172, 20, 0, 5)}`,
        `c ${ip(192, 168, 1, 1)}`,
        `d ${ip(100, 100, 1, 2)}`,
        `e ${ip(192, 0, 2, 10)}`,
        `f ${ip(198, 51, 100, 7)}`,
        `g 127.0.0.1`,
      ].join("\n")).map((f) => f.rule),
      ["private address in 10/8", "private address in 172.16/12", "private address in 192.168/16", "private address in 100.64/10"],
    );
  });

  it("finds token prefixes", () => {
    assert.deepEqual(scanText("github_pat_ABCDEFGHIJKLMNOP").map((f) => f.rule), ["github token"]);
    assert.deepEqual(scanText("ghp_ABCDEFGHIJKLMNOP").map((f) => f.rule), ["github token"]);
    assert.deepEqual(scanText("pcp_ABCDEFGHIJKLMNOP").map((f) => f.rule), ["other token prefix"]);
    assert.deepEqual(scanText("sk-ABCDEFGHIJKLMNOP").map((f) => f.rule), ["other token prefix"]);
  });

  it("finds every GitHub token prefix", () => {
    for (const prefix of ["ghp", "gho", "ghs", "ghu", "ghr"]) {
      const token = [prefix, "A".repeat(24)].join("_");
      assert.deepEqual(scanText(`value ${token}`).map((f) => f.rule), ["github token"], prefix);
    }
    assert.deepEqual(scanText(`laughs_${"a".repeat(24)}`), []);
  });

  it("does not mistake ordinary hyphenated words for a token prefix", () => {
    for (const word of ["risk-assessment", "disk-pressure", "task-scheduler", "ask-user-questions", "task-connector-read-routes"]) {
      assert.deepEqual(scanText(`see ${word} for details`), [], word);
    }
    assert.deepEqual(scanText("sk-XXXXXXXX").map((f) => f.rule), ["other token prefix"]);
    assert.deepEqual(scanText("key=sk-XXXXXXXX").map((f) => f.rule), ["other token prefix"]);
    assert.deepEqual(scanText("pcp_XXXXXXXX").map((f) => f.rule), ["other token prefix"]);
    assert.deepEqual(scanText("wrapcp_XXXXXXXX"), []);
  });

  it("finds quoted JSON keys", () => {
    assert.deepEqual(scanText(`{"${["pass", "word"].join("")}": "x"}`).map((f) => f.rule), ["secret-like assignment"]);
    assert.deepEqual(scanText(`"${["api", "key"].join("_")}": "x"`).map((f) => f.rule), ["secret-like assignment"]);
    assert.deepEqual(scanText(`'${["to", "ken"].join("")}' = x`).map((f) => f.rule), ["secret-like assignment"]);
  });

  it("finds secret paths in Markdown code spans and links", () => {
    assert.deepEqual(scanText("file `/etc/myrmidon/secrets.env`").map((f) => f.rule), ["secret file path"]);
    assert.deepEqual(scanText("key `~/.ssh/id_ed25519`").map((f) => f.rule), ["secret file path"]);
    assert.deepEqual(scanText("(~/.ssh/config)").map((f) => f.rule), ["secret file path"]);
  });

  it("finds credentials in a URL", () => {
    const url = `postgres://${["app", "pw"].join(":")}@db.example.com/main`;
    assert.deepEqual(scanText(url).map((f) => f.rule), ["credentials in URL"]);
    assert.deepEqual(scanText("https://example.com:8080/path and ssh://git@example.com/repo"), []);
  });

  it("finds a Telegram bot token", () => {
    const token = ["123456789", "A".repeat(35)].join(":");
    assert.deepEqual(scanText(`bot ${token}`).map((f) => f.rule), ["telegram bot token"]);
    assert.deepEqual(scanText(`bot ${token.slice(0, -1)}-`).map((f) => f.rule), ["telegram bot token"]);
    assert.deepEqual(scanText("time 12:30:45 and 2026:09:29"), []);
  });

  it("finds private key headers and secret file paths", () => {
    assert.deepEqual(scanText("-----BEGIN RSA PRIVATE KEY-----").map((f) => f.rule), ["private key header"]);
    assert.deepEqual(scanText("cat ~/.ssh/id_rsa").map((f) => f.rule), ["secret file path"]);
    assert.deepEqual(scanText("read /etc/myrmidon/secrets.env").map((f) => f.rule), ["secret file path"]);
  });

  it("reports line numbers for multiline text", () => {
    const findings = scanText(`first\nsecond\n${passwordPair}`);
    assert.deepEqual(findings, [{ line: 3, rule: "secret-like assignment" }]);
  });

  it("ignores version strings and invalid octets", () => {
    assert.deepEqual(scanText(`v${ip(1, 10, 1, 2, 3)}`), []);
    assert.deepEqual(scanText(`a ${ip(10, 300, 1, 1)} b`), []);
    assert.deepEqual(scanText(`x 10.1.2`), []);
  });
});

describe("scanLine", () => {
  it("reports one finding per matched address on the line", () => {
    const findings = scanLine(`a=${ip(10, 0, 0, 1)} b=${ip(10, 0, 0, 2)}`, 7);
    assert.deepEqual(findings, [
      { line: 7, rule: "private address in 10/8" },
      { line: 7, rule: "private address in 10/8" },
    ]);
  });

  it("reports a regex rule once per line even if it matches twice", () => {
    const pair = ["token", "AAAA"].join("=");
    const findings = scanLine(`${pair} and ${pair}`, 3);
    assert.deepEqual(findings, [{ line: 3, rule: "secret-like assignment" }]);
  });
});

describe("summarizeFindings", () => {
  it("counts findings by rule", () => {
    assert.deepEqual(
      summarizeFindings([
        { line: 1, rule: "a" },
        { line: 2, rule: "a" },
        { line: 3, rule: "b" },
      ]),
      [
        { rule: "a", count: 2 },
        { rule: "b", count: 1 },
      ],
    );
  });
});

describe("forbidden patterns", () => {
  const host = ["corp", "example", "lan"].join("-");
  const env = { MYRMIDON_FORBIDDEN_PATTERNS: `# ours\n${host}` };

  it("warns and passes when the list is not set", () => {
    const { code, output } = run(`HOST=${host}`, [], {});
    assert.equal(code, 0);
    assert.match(output, /::warning .*MYRMIDON_FORBIDDEN_PATTERNS is not set/);
  });

  it("fails on a match without printing the pattern or the text", () => {
    const { code, output } = run(`ok\nHOST=${host}`, [], env);
    assert.equal(code, 1);
    assert.match(output, /::error line=2::forbidden pattern #2/);
    assert.ok(!output.includes(host));
    assert.ok(!/::warning/.test(output));
  });

  it("still applies the built-in rules when the list is set", () => {
    const { code, output } = run(`connect to ${ip(10, 10, 10, 4)}`, [], env);
    assert.equal(code, 1);
    assert.match(output, /private address in 10\/8/);
  });
});

describe("main", () => {
  it("exits 0 on clean text", () => {
    const { code, output } = run("Plain text with example.com only.");
    assert.equal(code, 0);
    assert.match(output, /Scanned 1 line\(s\): 0 finding\(s\)/);
  });

  it("exits 1 on a secret and never prints the value", () => {
    const { code, output } = run(`before\n${passwordPair}\nafter`);
    assert.equal(code, 1);
    assert.match(output, /::error line=2::secret-like assignment/);
    assert.ok(!output.includes("hunter2"));
  });

  it("exits 1 on an internal address and never prints it", () => {
    const { code, output } = run(`connect to ${ip(10, 10, 10, 4)}`);
    assert.equal(code, 1);
    assert.match(output, /::error line=1::private address in 10\/8/);
    assert.ok(!output.includes(ip(10, 10, 10, 4)));
  });

  it("exits 1 on a github token and never prints it", () => {
    const token = ["github_pat", "XXX"].join("_");
    const { code, output } = run(`token is ${token}`);
    assert.equal(code, 1);
    assert.ok(!output.includes(token));
  });

  it("exits 2 on a missing file", () => {
    const lines = [];
    const log = { log: (m) => lines.push(m), error: (m) => lines.push(m) };
    assert.equal(main(["--file", "/nonexistent/missing.txt"], {}, log), 2);
  });

  it("exits 2 when stdin cannot be read instead of reporting a clean scan", () => {
    const lines = [];
    const log = { log: (m) => lines.push(m), error: (m) => lines.push(m) };
    const failing = () => {
      throw Object.assign(new Error("resource temporarily unavailable"), { code: "EAGAIN" });
    };
    assert.equal(main([], {}, log, failing), 2);
    assert.match(lines.join("\n"), /Cannot read stdin: EAGAIN/);
    assert.ok(!lines.some((m) => /Scanned/.test(m)));
  });

  it("reads stdin when no file is given", () => {
    const lines = [];
    const log = { log: (m) => lines.push(m), error: (m) => lines.push(m) };
    assert.equal(main([], {}, log, () => "plain text"), 0);
    assert.equal(main([], {}, log, () => `x ${ip(10, 0, 0, 1)}`), 1);
  });

  it("exits 2 when --file has no path", () => {
    const lines = [];
    const log = { log: (m) => lines.push(m), error: (m) => lines.push(m) };
    assert.equal(main(["--file"], {}, log, () => "plain text"), 2);
  });

  it("exits 2 on an unknown argument", () => {
    const lines = [];
    const log = { log: (m) => lines.push(m), error: (m) => lines.push(m) };
    assert.equal(main(["--nope"], {}, log), 2);
  });
});
