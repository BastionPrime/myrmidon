import { describe, expect, it } from "vitest";

import {
  BUNDLE_MAX_FILES,
  BUNDLE_MAX_FILE_BYTES,
  BUNDLE_MAX_PATH_LENGTH,
  DEFAULT_CARD_INSTRUCTIONS,
  INSTRUCTIONS_SEPARATOR,
  composeAgentsMd,
  loadBotInstructionsBundle,
  resolveCardInstructions,
  type BotInstructionsBundleListing,
  type BotInstructionsBundleSource,
} from "./instructions-source.js";

// Placeholder file names and text only.

describe("myrmidon(W2a) resolveCardInstructions", () => {
  it("takes the card's instructions, trimmed", () => {
    expect(resolveCardInstructions({ instructions: "  Be brief.  " })).toBe("Be brief.");
  });

  it("falls back to the payload template's instructions, then to the default line", () => {
    expect(resolveCardInstructions({ payloadTemplate: { instructions: "From template." } })).toBe("From template.");
    expect(resolveCardInstructions({ instructions: "  ", payloadTemplate: { instructions: "From template." } })).toBe(
      "From template.",
    );
    expect(resolveCardInstructions({})).toBe(DEFAULT_CARD_INSTRUCTIONS);
    expect(resolveCardInstructions({ instructions: 7, payloadTemplate: "nope" })).toBe(DEFAULT_CARD_INSTRUCTIONS);
  });

  it("prefers the card's own field over the template's", () => {
    expect(resolveCardInstructions({ instructions: "Own.", payloadTemplate: { instructions: "Template." } })).toBe("Own.");
  });
});

describe("myrmidon(W2a) composeAgentsMd", () => {
  it("joins the bundle's entry text and the card's instructions with the adapter's separator", () => {
    expect(composeAgentsMd("# Role\n", "Be brief.")).toBe(`# Role${INSTRUCTIONS_SEPARATOR}Be brief.`);
    expect(INSTRUCTIONS_SEPARATOR).toBe("\n\n---\n\n");
  });

  it("is the card's instructions alone when there is no bundle text", () => {
    expect(composeAgentsMd("", "Be brief.")).toBe("Be brief.");
    expect(composeAgentsMd("  \n ", "Be brief.")).toBe("Be brief.");
  });
});

function source(
  listing: BotInstructionsBundleListing | null,
  contents: Record<string, string> = {},
): { source: BotInstructionsBundleSource; reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    source: {
      async listBundle() {
        return listing;
      },
      async readFile(relativePath) {
        reads.push(relativePath);
        const content = contents[relativePath];
        if (content === undefined) throw new Error(`no such file: ${relativePath}`);
        return content;
      },
    },
  };
}

describe("myrmidon(W2a) loadBotInstructionsBundle", () => {
  it("returns nothing for an agent without a bundle, and reads nothing", async () => {
    const { source: src, reads } = source(null);
    expect(await loadBotInstructionsBundle(src)).toEqual({ entryText: "", files: [], warnings: [] });
    expect(reads).toEqual([]);
  });

  it("reads the entry file and every other file of a four-file bundle, sorted by path", async () => {
    const { source: src } = source(
      {
        entryFile: "AGENTS.md",
        files: [
          { path: "SOUL.md", size: 8 },
          { path: "docs/style.md", size: 9 },
          { path: "AGENTS.md", size: 7 },
          { path: "HEARTBEAT.md", size: 12 },
        ],
      },
      { "AGENTS.md": "# Role\n", "SOUL.md": "# Soul\n", "docs/style.md": "# Style\n", "HEARTBEAT.md": "# Heartbeat\n" },
    );
    expect(await loadBotInstructionsBundle(src)).toEqual({
      entryText: "# Role\n",
      files: [
        { path: "HEARTBEAT.md", content: "# Heartbeat\n" },
        { path: "SOUL.md", content: "# Soul\n" },
        { path: "docs/style.md", content: "# Style\n" },
      ],
      warnings: [],
    });
  });

  it("uses the bundle's own entry file name, and does not repeat the entry among the siblings", async () => {
    const { source: src } = source(
      {
        entryFile: "ROLE.md",
        files: [
          { path: "ROLE.md", size: 5 },
          { path: "NOTES.md", size: 5 },
        ],
      },
      { "ROLE.md": "role", "NOTES.md": "notes" },
    );
    const loaded = await loadBotInstructionsBundle(src);
    expect(loaded.entryText).toBe("role");
    expect(loaded.files.map((file) => file.path)).toEqual(["NOTES.md"]);
  });

  it("has an empty entry text when the entry file is missing, but still passes the siblings", async () => {
    const { source: src } = source(
      { entryFile: "AGENTS.md", files: [{ path: "NOTES.md", size: 5 }] },
      { "NOTES.md": "notes" },
    );
    const loaded = await loadBotInstructionsBundle(src);
    expect(loaded.entryText).toBe("");
    expect(loaded.files).toEqual([{ path: "NOTES.md", content: "notes" }]);
  });

  it("skips a virtual file (the board's legacy prompt template), which is not on disk", async () => {
    const { source: src, reads } = source(
      {
        entryFile: "AGENTS.md",
        files: [
          { path: "AGENTS.md", size: 3 },
          { path: "prompt-template.legacy", size: 4, virtual: true },
        ],
      },
      { "AGENTS.md": "abc" },
    );
    const loaded = await loadBotInstructionsBundle(src);
    expect(loaded.files).toEqual([]);
    expect(reads).toEqual(["AGENTS.md"]);
  });

  it("skips an oversized file with a warning, without reading it", async () => {
    const { source: src, reads } = source(
      {
        entryFile: "AGENTS.md",
        files: [
          { path: "AGENTS.md", size: 3 },
          { path: "big.md", size: BUNDLE_MAX_FILE_BYTES + 1 },
        ],
      },
      { "AGENTS.md": "abc", "big.md": "x" },
    );
    const loaded = await loadBotInstructionsBundle(src);
    expect(loaded.files).toEqual([]);
    expect(loaded.warnings).toEqual([`instructions bundle: big.md is larger than ${BUNDLE_MAX_FILE_BYTES} bytes, skipped`]);
    expect(reads).not.toContain("big.md");
  });

  it("skips a binary file with a warning", async () => {
    const { source: src } = source(
      {
        entryFile: "AGENTS.md",
        files: [
          { path: "AGENTS.md", size: 3 },
          { path: "logo.bin", size: 4 },
        ],
      },
      { "AGENTS.md": "abc", "logo.bin": "a\u0000b" },
    );
    const loaded = await loadBotInstructionsBundle(src);
    expect(loaded.files).toEqual([]);
    expect(loaded.warnings).toEqual(["instructions bundle: logo.bin is binary, skipped"]);
  });

  it("skips a path that is too long, with a warning that does not print the whole path", async () => {
    const longPath = `${"d/".repeat(BUNDLE_MAX_PATH_LENGTH)}a.md`;
    const { source: src } = source({ entryFile: "AGENTS.md", files: [{ path: longPath, size: 3 }] }, { [longPath]: "abc" });
    const loaded = await loadBotInstructionsBundle(src);
    expect(loaded.files).toEqual([]);
    expect(loaded.warnings).toHaveLength(1);
    expect(loaded.warnings[0]?.length).toBeLessThan(200);
  });

  it("stops at the file-count limit with a warning naming the first file left out", async () => {
    const files = Array.from({ length: BUNDLE_MAX_FILES + 3 }, (_, index) => ({
      path: `f${String(index).padStart(3, "0")}.md`,
      size: 1,
    }));
    const contents = Object.fromEntries(files.map((file) => [file.path, "x"]));
    const { source: src } = source({ entryFile: "AGENTS.md", files }, contents);
    const loaded = await loadBotInstructionsBundle(src);
    expect(loaded.files).toHaveLength(BUNDLE_MAX_FILES);
    expect(loaded.warnings).toEqual([
      `instructions bundle: more than ${BUNDLE_MAX_FILES} files, f${String(BUNDLE_MAX_FILES).padStart(3, "0")}.md and the rest skipped`,
    ]);
  });

  it("lets a failing read fail the load: a half-loaded bundle must not look complete", async () => {
    const { source: src } = source(
      {
        entryFile: "AGENTS.md",
        files: [
          { path: "AGENTS.md", size: 3 },
          { path: "gone.md", size: 3 },
        ],
      },
      { "AGENTS.md": "abc" },
    );
    await expect(loadBotInstructionsBundle(src)).rejects.toThrow("no such file: gone.md");
  });
});
