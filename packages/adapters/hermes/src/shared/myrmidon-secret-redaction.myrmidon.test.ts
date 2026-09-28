import { describe, expect, it } from "vitest";

import { redactSecretsForLog } from "./myrmidon-secret-redaction.js";

// Fake, illustrative token/credential shapes for testing the masking
// patterns below — never real values (see docs/myrmidon/CONVENTIONS.md,
// section 7: no keys in tests). Built from two literal halves joined at
// runtime, not as one contiguous secret-shaped literal, so a source-text
// secret scanner (this repo runs gitleaks in CI) does not flag its own
// fixture data as a leaked credential.
const FAKE_ANTHROPIC_KEY = "sk-ant-" + "abcdef0123456789";
const FAKE_OPENAI_STYLE_KEY = "sk-" + "1234567890abcdef";
const FAKE_QUERY_KEY = "abc123" + "def456";
const FAKE_BEARER_TOKEN = "abcdEFGH" + "12345678";
const FAKE_DB_PASSWORD = "hunter2correct" + "horse";
const FAKE_CONNSTRING_PASSWORD = "hunter" + "2";
const FAKE_SPACED_PASSWORD = "correct horse" + " battery staple";
const FAKE_GITHUB_TOKEN = "ghp_" + "abcdefghijklmnopqrstuvwxyz012345";
const FAKE_AWS_KEY = "AKIA" + "ABCDEFGHIJKLMNOP";

describe("redactSecretsForLog", () => {
  it("masks an Authorization: Bearer header inside a raw terminal tool-progress line", () => {
    // This is exactly the shape live-progress mode prints for a `curl` call
    // once -Q is bypassed (agent/display.py's "terminal" preview builder,
    // which is NOT covered by the vendor's own redact_tool_args_for_display).
    const line = `┊ 💻 $         curl -s -H "Authorization: Bearer ${FAKE_ANTHROPIC_KEY}" https://example.com  0.1s`;
    const result = redactSecretsForLog(line);
    expect(result).not.toContain(FAKE_ANTHROPIC_KEY);
    expect(result).toContain("Authorization: Bearer [REDACTED]");
    expect(result).toContain("curl -s -H");
    expect(result).toContain("https://example.com");
  });

  it("masks a bare Bearer token outside an Authorization: header", () => {
    const result = redactSecretsForLog(`curl -H "Bearer ${FAKE_BEARER_TOKEN}" https://example.com`);
    expect(result).not.toContain(FAKE_BEARER_TOKEN);
    expect(result).toContain("Bearer [REDACTED]");
  });

  it("masks key=value / token=value / password=value assignments", () => {
    expect(redactSecretsForLog(`API_KEY=${FAKE_OPENAI_STYLE_KEY} ./deploy.sh`)).not.toContain(FAKE_OPENAI_STYLE_KEY);
    expect(redactSecretsForLog(`curl "https://api.example.com/v1?api_key=${FAKE_QUERY_KEY}"`)).not.toContain(
      FAKE_QUERY_KEY,
    );
    expect(redactSecretsForLog(`psql --password=${FAKE_CONNSTRING_PASSWORD} -U admin`)).not.toContain(
      FAKE_CONNSTRING_PASSWORD,
    );
    expect(redactSecretsForLog(`export DB_PASSWORD="${FAKE_DB_PASSWORD}"`)).not.toContain(FAKE_DB_PASSWORD);
  });

  it("masks a quoted key=value secret whose value contains whitespace", () => {
    // KEY_VALUE_SECRET_RE's quoted branch must scan for the actual closing
    // quote, not stop at the first space inside it. A value group that
    // simply excludes whitespace (`[^\s'",;&]+`) can never reach the closing
    // quote once the value itself contains a space, so the WHOLE match
    // attempt used to fail — not even a partial redaction — leaving a
    // spaced, quoted secret completely unmasked (e.g. a `mysql --password="…"`
    // invocation, or a `terminal` tool-progress line echoing it).
    const line = `mysql --password="${FAKE_SPACED_PASSWORD}"`;
    const result = redactSecretsForLog(line);
    expect(result).not.toContain(FAKE_SPACED_PASSWORD);
    expect(result).toBe('mysql --password="[REDACTED]"');
  });

  it("masks user:password@ credentials in a connection string / URL", () => {
    const result = redactSecretsForLog(`psql postgres://admin:${FAKE_CONNSTRING_PASSWORD}@db.example.com:5432/prod`);
    expect(result).not.toContain(FAKE_CONNSTRING_PASSWORD);
    expect(result).not.toContain(`admin:${FAKE_CONNSTRING_PASSWORD}`);
    expect(result).toContain("postgres://[REDACTED]@db.example.com:5432/prod");
  });

  it("masks common vendor API key prefixes wherever they appear", () => {
    expect(redactSecretsForLog(`token is ${FAKE_ANTHROPIC_KEY}, keep it safe`)).not.toContain(FAKE_ANTHROPIC_KEY);
    expect(redactSecretsForLog(FAKE_GITHUB_TOKEN)).not.toContain(FAKE_GITHUB_TOKEN);
    expect(redactSecretsForLog(FAKE_AWS_KEY)).toBe("[REDACTED]");
  });

  it("leaves ordinary command output and prose completely unchanged", () => {
    const lines = [
      '┊ 💻 $         curl -s "https://example.com/health"  0.1s',
      "[done] ┊ 📖 read      README.md  0.0s",
      "Fixed the missing null check in the session lookup.",
      "- Verified with a targeted run",
    ];
    for (const line of lines) {
      expect(redactSecretsForLog(line)).toBe(line);
    }
  });

  it("is safe to call repeatedly (module-level global regexes do not leak state across calls)", () => {
    const line = `Authorization: Bearer ${FAKE_ANTHROPIC_KEY}`;
    const first = redactSecretsForLog(line);
    const second = redactSecretsForLog(line);
    expect(first).toBe(second);
    expect(first).not.toContain(FAKE_ANTHROPIC_KEY);
  });
});
