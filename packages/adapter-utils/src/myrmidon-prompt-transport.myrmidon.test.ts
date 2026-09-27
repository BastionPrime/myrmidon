import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cliHelpMentionsFlag,
  MYRMIDON_PROMPT_ARG_MAX_BYTES,
  PROMPT_TOO_LARGE_FOR_ARGUMENT,
  promptArgumentOverflowResult,
  resetCliFlagSupportCache,
  writePromptFile,
} from "./myrmidon-prompt-transport.js";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "myrmidon-prompt-transport-unit-"));
  resetCliFlagSupportCache();
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("promptArgumentOverflowResult", () => {
  it("accepts a prompt up to the single-argument limit", () => {
    expect(promptArgumentOverflowResult("Example CLI", "a".repeat(MYRMIDON_PROMPT_ARG_MAX_BYTES))).toBeNull();
  });

  it("counts UTF-8 bytes, not characters", () => {
    const prompt = "é".repeat(Math.floor(MYRMIDON_PROMPT_ARG_MAX_BYTES / 2) + 1);
    expect(promptArgumentOverflowResult("Example CLI", prompt)?.errorCode).toBe(
      PROMPT_TOO_LARGE_FOR_ARGUMENT,
    );
  });

  it("fails before launch with a readable message", () => {
    const result = promptArgumentOverflowResult("Example CLI", "a".repeat(300 * 1024));
    expect(result).toMatchObject({
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: PROMPT_TOO_LARGE_FOR_ARGUMENT,
    });
    expect(result?.errorMessage).toContain("Example CLI");
    expect(result?.errorMessage).toContain(String(300 * 1024));
  });
});

describe("writePromptFile", () => {
  it("writes a private file and removes it on cleanup", async () => {
    const prompt = `head\n${"x".repeat(300 * 1024)}\ntail`;
    const file = await writePromptFile(prompt, { tmpDir: root });
    expect(await fs.readFile(file.path, "utf8")).toBe(prompt);
    expect((await fs.stat(file.path)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(path.dirname(file.path))).mode & 0o777).toBe(0o700);
    await file.cleanup();
    await expect(fs.stat(path.dirname(file.path))).rejects.toThrow();
  });
});

describe("cliHelpMentionsFlag", () => {
  async function fakeCli(name: string, help: string, exitCode = 0): Promise<string> {
    const commandPath = path.join(root, name);
    await fs.writeFile(
      commandPath,
      `#!/usr/bin/env node\nconsole.log(${JSON.stringify(help)});\nprocess.exit(${exitCode});\n`,
      "utf8",
    );
    await fs.chmod(commandPath, 0o755);
    return commandPath;
  }

  it("finds a documented flag", async () => {
    const command = await fakeCli("new-cli", "Options:\n  --single <PROMPT>\n  --prompt-file <PATH>\n");
    expect(await cliHelpMentionsFlag(command, "--prompt-file")).toBe(true);
  });

  it("does not match a longer flag with the same prefix", async () => {
    const command = await fakeCli("old-cli", "Options:\n  --single <PROMPT>\n  --prompt-file-format <F>\n");
    expect(await cliHelpMentionsFlag(command, "--prompt-file")).toBe(false);
  });

  it("treats a failing or missing command as unsupported", async () => {
    const failing = await fakeCli("failing-cli", "--prompt-file", 2);
    expect(await cliHelpMentionsFlag(failing, "--prompt-file")).toBe(false);
    expect(await cliHelpMentionsFlag(path.join(root, "missing"), "--prompt-file")).toBe(false);
  });
});
