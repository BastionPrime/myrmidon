// @vitest-environment jsdom

import type { IssueAttachment, IssueWorkProduct } from "@paperclipai/shared";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildIssueFileEntries, IssueFilesPanel, issueFileViewer } from "./IssueFilesPanel";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function attachment(overrides: Partial<IssueAttachment>): IssueAttachment {
  const id = overrides.id ?? "att-1";
  return {
    id,
    companyId: "company-a",
    issueId: "issue-a",
    issueCommentId: null,
    assetId: `asset-${id}`,
    provider: "local_disk",
    objectKey: `objects/${id}`,
    contentType: "application/octet-stream",
    byteSize: 1024,
    sha256: "0".repeat(64),
    originalFilename: `${id}.bin`,
    createdByAgentId: "agent-a",
    createdByUserId: null,
    createdAt: new Date("2026-09-27T10:00:00Z"),
    updatedAt: new Date("2026-09-27T10:00:00Z"),
    contentPath: `/api/attachments/${id}/content`,
    ...overrides,
  };
}

function workProduct(overrides: Partial<IssueWorkProduct>): IssueWorkProduct {
  return {
    id: "wp-1",
    companyId: "company-a",
    projectId: null,
    issueId: "issue-a",
    executionWorkspaceId: null,
    runtimeServiceId: null,
    type: "artifact",
    provider: "paperclip",
    externalId: null,
    title: "report.pdf",
    url: null,
    status: "active",
    reviewState: "none",
    isPrimary: false,
    healthStatus: "unknown",
    summary: null,
    metadata: null,
    createdByRunId: null,
    createdAt: new Date("2026-09-27T11:00:00Z"),
    updatedAt: new Date("2026-09-27T11:00:00Z"),
    ...overrides,
  } as IssueWorkProduct;
}

describe("issueFileViewer", () => {
  it.each([
    ["image/png", "mock.png", "image"],
    ["video/mp4", "clip.mp4", "video"],
    ["video/webm", "clip.webm", "video"],
    ["video/quicktime", "clip.mov", "video"],
    ["application/octet-stream", "clip.mov", "video"],
    ["audio/mpeg", "voice.mp3", "audio"],
    ["application/pdf", "spec.pdf", "pdf"],
    ["application/zip", "bundle.zip", "download"],
    ["text/plain", "notes.txt", "download"],
  ] as const)("%s %s -> %s", (contentType, originalFilename, viewer) => {
    expect(issueFileViewer({ contentType, originalFilename })).toBe(viewer);
  });
});

describe("buildIssueFileEntries", () => {
  it("includes attachments without a comment and deduplicates work-product files", () => {
    const { files, links } = buildIssueFileEntries(
      [attachment({ id: "att-1", issueCommentId: null }), attachment({ id: "att-2", issueCommentId: "comment-1" })],
      [
        workProduct({ id: "wp-dup", metadata: { attachmentId: "att-1", contentPath: "/api/attachments/att-1/content" } }),
        workProduct({
          id: "wp-file",
          title: "report.pdf",
          metadata: {
            attachmentId: "att-3",
            contentType: "application/pdf",
            byteSize: 2048,
            contentPath: "/api/attachments/att-3/content",
          },
        }),
        workProduct({ id: "wp-link", title: "Pull request", url: "https://example.com/pr/1" }),
      ],
    );
    expect(files.map((file) => file.id).sort()).toEqual(["att-1", "att-2", "att-3"]);
    expect(files.find((file) => file.id === "att-1")?.commentId).toBeNull();
    expect(files.find((file) => file.id === "att-3")?.viewer).toBe("pdf");
    expect(links.map((link) => link.id)).toEqual(["wp-link"]);
  });
});

describe("IssueFilesPanel", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
  });

  function render(attachments: IssueAttachment[], workProducts: IssueWorkProduct[] = []) {
    flushSync(() => {
      root.render(
        <IssueFilesPanel
          attachments={attachments}
          workProducts={workProducts}
          resolveAuthor={(entry) => (entry.createdByAgentId ? "agent-a" : null)}
        />,
      );
    });
  }

  it("shows a file that is not bound to any comment", () => {
    render([attachment({ id: "att-free", originalFilename: "mockup.zip" })]);
    const row = container.querySelector('[data-testid="issue-file"]');
    expect(row?.textContent).toContain("mockup.zip");
    expect(row?.textContent).toContain("agent-a");
    expect(row?.querySelector('a[href^="#comment-"]')).toBeNull();
    expect(row?.querySelector("a[download]")?.getAttribute("href")).toBe(
      "/api/attachments/att-free/content?download=1",
    );
  });

  it("links a bound file to its comment", () => {
    render([attachment({ id: "att-bound", issueCommentId: "c9" })]);
    expect(container.querySelector('a[href="#comment-c9"]')).not.toBeNull();
  });

  it("renders the right viewer for each file type", () => {
    render([
      attachment({ id: "img", contentType: "image/png", originalFilename: "mock.png" }),
      attachment({ id: "vid", contentType: "video/mp4", originalFilename: "clip.mp4" }),
      attachment({ id: "aud", contentType: "audio/mpeg", originalFilename: "voice.mp3" }),
      attachment({ id: "doc", contentType: "application/pdf", originalFilename: "spec.pdf" }),
    ]);
    const img = container.querySelector("img");
    expect(img?.getAttribute("src")).toBe("/api/attachments/img/content");
    expect(img?.closest("a")?.getAttribute("target")).toBe("_blank");

    const video = container.querySelector("video");
    expect(video?.getAttribute("src")).toBe("/api/attachments/vid/content");
    expect(video?.hasAttribute("controls")).toBe(true);
    expect(video?.hasAttribute("autoplay")).toBe(false);
    expect(video?.hasAttribute("muted")).toBe(false);

    expect(container.querySelector("audio")?.hasAttribute("controls")).toBe(true);

    const pdfLink = container.querySelector('[data-viewer="pdf"] a');
    expect(pdfLink?.getAttribute("target")).toBe("_blank");
    expect(pdfLink?.getAttribute("href")).toBe("/api/attachments/doc/content");
  });

  it("renders nothing without files", () => {
    render([]);
    expect(container.querySelector('[data-testid="issue-files-panel"]')).toBeNull();
  });
});
