// myrmidon(EXT-CASE-OCR): where the recognized text is stored.
//
// The directory writer is the deployment that wants a copy on disk; the file
// name is the part that matters for safety, so the suite hands it hostile names
// ("../../etc/passwd") and checks that nothing can leave the root.

import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDiscardWorkspaceWriter,
  createDirectoryWorkspaceWriter,
  ocrWorkspaceFileName,
  workspaceWriterFromDirectory,
} from "./workspace.js";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ocr-workspace-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
});

describe("ocrWorkspaceFileName", () => {
  it("keeps the base name and appends a content hash", () => {
    const name = ocrWorkspaceFileName("tender.pdf", "text");
    expect(name).toMatch(/^tender-[0-9a-f]{8}\.txt$/);
  });

  it("cannot leave the root directory", () => {
    const name = ocrWorkspaceFileName("../../etc/passwd", "text");
    expect(name.includes("/")).toBe(false);
    expect(name.includes("..")).toBe(false);
    expect(name.startsWith("passwd-")).toBe(true);
  });

  it("gives a different file to the same name with different text", () => {
    expect(ocrWorkspaceFileName("tender.pdf", "a")).not.toBe(ocrWorkspaceFileName("tender.pdf", "b"));
  });

  it("falls back to a generic stem for a name of punctuation only", () => {
    expect(ocrWorkspaceFileName("...", "text").startsWith("document-")).toBe(true);
  });
});

describe("workspace writers", () => {
  it("writes the text under the root with owner-only permissions", async () => {
    const root = await tempRoot();
    const writer = createDirectoryWorkspaceWriter(root);
    const { path } = await writer.write({ name: "tender.pdf", text: "recognized text" });

    expect(path.startsWith(`${root}/`)).toBe(true);
    expect(await readFile(path, "utf8")).toBe("recognized text\n");
    const mode = (await stat(path)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("creates a missing root", async () => {
    const root = await tempRoot();
    const nested = join(root, "deep", "nested");
    await createDirectoryWorkspaceWriter(nested).write({ name: "tender.pdf", text: "text" });
    await expect(readFile(join(nested, ocrWorkspaceFileName("tender.pdf", "text")), "utf8")).resolves.toBe("text\n");
  });

  it("answers the discard writer when no directory is configured", async () => {
    await expect(workspaceWriterFromDirectory(null).write({ name: "tender.pdf", text: "text" })).resolves.toEqual({
      path: "",
    });
    await expect(createDiscardWorkspaceWriter().write({ name: "tender.pdf", text: "text" })).resolves.toEqual({
      path: "",
    });
    await expect(workspaceWriterFromDirectory("   ").write({ name: "a.pdf", text: "t" })).resolves.toEqual({ path: "" });
  });
});