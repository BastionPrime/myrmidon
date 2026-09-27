import { useMemo } from "react";
import type { IssueAttachment, IssueWorkProduct } from "@paperclipai/shared";
import { Download, ExternalLink, FileText, Link2 } from "lucide-react";
import { Card } from "@/components/ui/card";
import { OutputVideoPlayer } from "@/components/issue-output/OutputVideoPlayer";
import { formatBytes } from "@/lib/issue-output";
import {
  attachmentDownloadPath,
  attachmentFilename,
  attachmentOpenPath,
  isImageAttachment,
  isVideoAttachment,
} from "@/lib/issue-attachments";

// myrmidon(U3): every file of the task in one panel, including attachments
// that are not bound to a comment and files delivered as work products.

export type IssueFileViewer = "image" | "video" | "audio" | "pdf" | "download";

export interface IssueFileEntry {
  id: string;
  name: string;
  contentType: string;
  byteSize: number | null;
  createdAt: string | Date;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  commentId: string | null;
  contentPath: string;
  openPath: string;
  downloadPath: string;
  viewer: IssueFileViewer;
}

export interface IssueLinkEntry {
  id: string;
  title: string;
  url: string;
  createdAt: string | Date;
}

function normalizedType(contentType: string): string {
  return contentType.toLowerCase().split(";")[0]?.trim() ?? "";
}

export function issueFileViewer(file: { contentType: string; originalFilename: string | null }): IssueFileViewer {
  const type = normalizedType(file.contentType);
  const name = (file.originalFilename ?? "").toLowerCase();
  if (isImageAttachment({ contentType: file.contentType })) return "image";
  if (isVideoAttachment(file) || /\.(mp4|webm|mov|m4v)$/.test(name)) return "video";
  if (type.startsWith("audio/") || /\.(mp3|wav|ogg|oga|m4a|aac|flac|opus)$/.test(name)) return "audio";
  if (type === "application/pdf" || name.endsWith(".pdf")) return "pdf";
  return "download";
}

function attachmentMetadata(product: IssueWorkProduct): {
  attachmentId: string;
  contentType: string;
  byteSize: number;
  contentPath: string;
  openPath?: string;
  downloadPath?: string;
} | null {
  const meta = product.metadata;
  if (!meta || typeof meta !== "object") return null;
  const { attachmentId, contentType, byteSize, contentPath } = meta as Record<string, unknown>;
  if (typeof attachmentId !== "string" || typeof contentPath !== "string") return null;
  return {
    attachmentId,
    contentType: typeof contentType === "string" ? contentType : "application/octet-stream",
    byteSize: typeof byteSize === "number" ? byteSize : 0,
    contentPath,
    openPath: typeof meta.openPath === "string" ? meta.openPath : undefined,
    downloadPath: typeof meta.downloadPath === "string" ? meta.downloadPath : undefined,
  };
}

/** Attachments first, then files and links from work products; newest first. */
export function buildIssueFileEntries(
  attachments: IssueAttachment[],
  workProducts: IssueWorkProduct[],
): { files: IssueFileEntry[]; links: IssueLinkEntry[] } {
  const files: IssueFileEntry[] = attachments.map((attachment) => ({
    id: attachment.id,
    name: attachmentFilename(attachment),
    contentType: attachment.contentType,
    byteSize: attachment.byteSize,
    createdAt: attachment.createdAt,
    createdByAgentId: attachment.createdByAgentId,
    createdByUserId: attachment.createdByUserId,
    commentId: attachment.issueCommentId,
    contentPath: attachment.contentPath,
    openPath: attachmentOpenPath(attachment),
    downloadPath: attachmentDownloadPath(attachment),
    viewer: issueFileViewer(attachment),
  }));
  const known = new Set(files.map((file) => file.id));
  const links: IssueLinkEntry[] = [];
  for (const product of workProducts) {
    const meta = attachmentMetadata(product);
    if (meta) {
      if (known.has(meta.attachmentId)) continue;
      known.add(meta.attachmentId);
      files.push({
        id: meta.attachmentId,
        name: product.title,
        contentType: meta.contentType,
        byteSize: meta.byteSize,
        createdAt: product.createdAt,
        createdByAgentId: null,
        createdByUserId: null,
        commentId: null,
        contentPath: meta.contentPath,
        openPath: meta.openPath ?? meta.contentPath,
        downloadPath: meta.downloadPath ?? `${meta.contentPath}?download=1`,
        viewer: issueFileViewer({ contentType: meta.contentType, originalFilename: product.title }),
      });
    } else if (product.url) {
      links.push({ id: product.id, title: product.title, url: product.url, createdAt: product.createdAt });
    }
  }
  const newestFirst = (a: { createdAt: string | Date }, b: { createdAt: string | Date }) =>
    new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  return { files: files.sort(newestFirst), links: links.sort(newestFirst) };
}

function FileViewer({ file }: { file: IssueFileEntry }) {
  switch (file.viewer) {
    case "image":
      return (
        <a href={file.openPath} target="_blank" rel="noreferrer" aria-label={`Open ${file.name} full size`}>
          <img src={file.contentPath} alt={file.name} loading="lazy" className="max-h-48 rounded-md object-contain" />
        </a>
      );
    case "video":
      return <OutputVideoPlayer src={file.contentPath} title={file.name} />;
    case "audio":
      return (
        <audio src={file.contentPath} controls preload="metadata" aria-label={`Audio: ${file.name}`} className="w-full" />
      );
    case "pdf":
      return (
        <a href={file.openPath} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm underline">
          <ExternalLink className="h-3.5 w-3.5" /> Open PDF
        </a>
      );
    default:
      return (
        <a href={file.downloadPath} download={file.name} className="inline-flex items-center gap-1 text-sm underline">
          <Download className="h-3.5 w-3.5" /> Download
        </a>
      );
  }
}

interface IssueFilesPanelProps {
  attachments: IssueAttachment[];
  workProducts: IssueWorkProduct[];
  /** Display name for the agent or user who delivered the file. */
  resolveAuthor?: (entry: Pick<IssueFileEntry, "createdByAgentId" | "createdByUserId">) => string | null;
}

export function IssueFilesPanel({ attachments, workProducts, resolveAuthor }: IssueFilesPanelProps) {
  const { files, links } = useMemo(
    () => buildIssueFileEntries(attachments, workProducts),
    [attachments, workProducts],
  );
  if (files.length === 0 && links.length === 0) return null;
  return (
    <Card className="gap-3 p-4" data-testid="issue-files-panel">
      <h3 className="text-sm font-medium">Files</h3>
      <ul className="flex flex-col gap-4">
        {files.map((file) => {
          const author = resolveAuthor?.(file) ?? null;
          return (
            <li key={file.id} data-testid="issue-file" data-viewer={file.viewer} className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-x-2 text-sm">
                <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="font-medium break-all">{file.name}</span>
                {file.byteSize != null && (
                  <span className="text-muted-foreground">{formatBytes(file.byteSize)}</span>
                )}
                <span className="text-muted-foreground">
                  {author ? `${author} · ` : ""}
                  {new Date(file.createdAt).toLocaleString()}
                </span>
                {file.commentId && (
                  <a href={`#comment-${file.commentId}`} className="text-muted-foreground underline">
                    comment
                  </a>
                )}
              </div>
              <FileViewer file={file} />
            </li>
          );
        })}
        {links.map((link) => (
          <li key={link.id} data-testid="issue-link" className="flex items-center gap-2 text-sm">
            <Link2 className="h-4 w-4 shrink-0 text-muted-foreground" />
            <a href={link.url} target="_blank" rel="noreferrer" className="underline break-all">
              {link.title}
            </a>
          </li>
        ))}
      </ul>
    </Card>
  );
}
