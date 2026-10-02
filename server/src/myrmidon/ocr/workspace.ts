// server/src/myrmidon/ocr/workspace.ts
//
// myrmidon(EXT-CASE-OCR): where the recognized text lands.
//
// The rule of the path is that the journal keeps metadata and the text goes to
// the workspace. "Workspace" depends on who asked: a container bot receives the
// text in the tool result and writes it into its own workspace, while a board
// deployment that wants a copy on disk names a directory with
// `MYRMIDON_OCR_WORKSPACE_DIR`. Both are the same small port, so the service
// neither knows nor cares which one is behind it.

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface OcrWorkspaceWriter {
  /** Stores the recognized text and answers where it landed. */
  write(input: { name: string; text: string }): Promise<{ path: string }>;
}

/** A writer that keeps nothing; the text only travels in the tool result. */
export function createDiscardWorkspaceWriter(): OcrWorkspaceWriter {
  return {
    async write() {
      return { path: "" };
    },
  };
}

/**
 * A file name that cannot leave the root directory and cannot surprise a reader:
 * the base name only, path separators and control characters replaced, length
 * bounded, and a hash of name + content appended so a second document does not
 * overwrite the first one's text.
 */
export function ocrWorkspaceFileName(name: string, text: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const stem = base
    .replace(/\.pdf$/i, "")
    .replace(/[^\p{L}\p{N}._ ()-]+/gu, "_")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 80);
  const safeStem = stem.length > 0 ? stem : "document";
  const hash = createHash("sha1").update(`${name}\u0000${text}`).digest("hex").slice(0, 8);
  return `${safeStem}-${hash}.txt`;
}

/** Writes the text under `<root>/<safe name>` (mode 0600), creating the root. */
export function createDirectoryWorkspaceWriter(root: string): OcrWorkspaceWriter {
  const rootDir = root.trim();
  return {
    async write(input) {
      if (!rootDir) throw new Error("OCR workspace directory is empty");
      await mkdir(rootDir, { recursive: true, mode: 0o700 });
      const path = join(rootDir, ocrWorkspaceFileName(input.name, input.text));
      await writeFile(path, `${input.text}\n`, { mode: 0o600 });
      return { path };
    },
  };
}

/** The writer for a configured directory, or the discard writer when none is set. */
export function workspaceWriterFromDirectory(directory: string | null | undefined): OcrWorkspaceWriter {
  const trimmed = directory?.trim();
  return trimmed ? createDirectoryWorkspaceWriter(trimmed) : createDiscardWorkspaceWriter();
}