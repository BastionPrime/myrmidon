import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AdapterExecutionResult } from "./types.js";

// myrmidon(H4): keep agent prompts out of the child's argv. A long prompt in a
// single argument hits the kernel limit (spawn E2BIG), and argv is readable by
// every local user through the process list.

/**
 * Largest prompt that can still travel as one command-line argument. Linux caps
 * a single argument at 128 KiB including its terminating NUL (MAX_ARG_STRLEN),
 * so anything larger fails at spawn with E2BIG anyway.
 */
export const MYRMIDON_PROMPT_ARG_MAX_BYTES = 128 * 1024 - 1;

export const PROMPT_TOO_LARGE_FOR_ARGUMENT = "prompt_too_large_for_argument";

/** UTF-8 size of a prompt, which is what the kernel counts. */
export function promptByteLength(prompt: string): number {
  return Buffer.byteLength(prompt, "utf8");
}

/**
 * A failed run result for a prompt that must travel as an argument but does
 * not fit, or null when it fits. Returned before anything is launched.
 */
export function promptArgumentOverflowResult(
  adapterLabel: string,
  prompt: string,
  limitBytes: number = MYRMIDON_PROMPT_ARG_MAX_BYTES,
): AdapterExecutionResult | null {
  const bytes = promptByteLength(prompt);
  if (bytes <= limitBytes) return null;
  return {
    exitCode: 1,
    signal: null,
    timedOut: false,
    errorCode: PROMPT_TOO_LARGE_FOR_ARGUMENT,
    errorMessage:
      `${adapterLabel} receives its prompt as a command-line argument, and this prompt is ` +
      `${bytes} bytes, above the ${limitBytes}-byte limit for one argument. Shorten the agent ` +
      `instructions or task context, or use a transport that reads the prompt from stdin.`,
  };
}

export interface PromptFile {
  path: string;
  cleanup: () => Promise<void>;
}

/**
 * Writes the prompt to a private (0600) file in a fresh 0700 directory for a
 * CLI that reads its prompt from a file. Call `cleanup` once the child exits.
 */
export async function writePromptFile(
  prompt: string,
  options: { tmpDir?: string; fileName?: string } = {},
): Promise<PromptFile> {
  const dir = await fs.mkdtemp(path.join(options.tmpDir ?? os.tmpdir(), "paperclip-prompt-"));
  try {
    await fs.chmod(dir, 0o700);
    const filePath = path.join(dir, options.fileName ?? `prompt-${randomUUID()}.md`);
    await fs.writeFile(filePath, prompt, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return {
      path: filePath,
      cleanup: () => fs.rm(dir, { recursive: true, force: true }),
    };
  } catch (error) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

const flagSupportCache = new Map<string, Promise<boolean>>();

/**
 * Whether `<command> --help` mentions `flag`. Used before switching a CLI to a
 * newer prompt transport so an older installed version keeps working. Results
 * are cached per command and PATH; any failure counts as unsupported.
 */
export function cliHelpMentionsFlag(
  command: string,
  flag: string,
  options: { env?: NodeJS.ProcessEnv; cwd?: string; timeoutMs?: number } = {},
): Promise<boolean> {
  const key = `${command}\u0000${flag}\u0000${options.env?.PATH ?? process.env.PATH ?? ""}`;
  const cached = flagSupportCache.get(key);
  if (cached) return cached;
  const probe = new Promise<boolean>((resolve) => {
    execFile(
      command,
      ["--help"],
      {
        env: options.env,
        cwd: options.cwd,
        timeout: options.timeoutMs ?? 10_000,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const text = `${stdout ?? ""}\n${stderr ?? ""}`;
        resolve(!error && new RegExp(`(^|[\\s,])${flag.replace(/[-]/g, "\\-")}(?![\\w-])`).test(text));
      },
    );
  });
  flagSupportCache.set(key, probe);
  return probe;
}

/** Test hook: forget cached `--help` probes. */
export function resetCliFlagSupportCache(): void {
  flagSupportCache.clear();
}
