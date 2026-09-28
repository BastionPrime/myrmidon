import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { IssueAttachment, IssueWorkProduct } from "@paperclipai/shared";
import { Paperclip } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { buildIssueFileEntries, IssueFilesPanel, type IssueFileEntry } from "./IssueFilesPanel";

// myrmidon(U1): task files move from a fixed card at the top of the chat
// shell into an on-demand drawer triggered from the task header, so they no
// longer crowd the transcript on small screens. Desktop opens a resizable
// side panel; mobile opens a near-full-height bottom sheet. Width is
// per-viewer and remembered across visits.

const WIDTH_STORAGE_KEY = "myrmidon.issueFilesDrawer.width";
const DEFAULT_WIDTH = 420;
const MIN_WIDTH = 320;
const MAX_WIDTH = 900;

function clampWidth(width: number): number {
  return Math.min(Math.max(Math.round(width), MIN_WIDTH), MAX_WIDTH);
}

function readStoredWidth(): number {
  if (typeof window === "undefined") return DEFAULT_WIDTH;
  try {
    const raw = window.localStorage.getItem(WIDTH_STORAGE_KEY);
    const parsed = raw === null ? Number.NaN : Number(raw);
    return Number.isFinite(parsed) ? clampWidth(parsed) : DEFAULT_WIDTH;
  } catch {
    // Private browsing, disabled storage, or quota errors — fall back silently.
    return DEFAULT_WIDTH;
  }
}

function persistWidth(width: number): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(WIDTH_STORAGE_KEY, String(width));
  } catch {
    // Ignore storage failures — the width just won't be remembered.
  }
}

export interface IssueFilesDrawerProps {
  attachments: IssueAttachment[];
  workProducts: IssueWorkProduct[];
  resolveAuthor?: (entry: Pick<IssueFileEntry, "createdByAgentId" | "createdByUserId">) => string | null;
  /** Selects the bottom full-height sheet instead of the resizable side panel. */
  isMobile: boolean;
  className?: string;
}

export function IssueFilesDrawer({
  attachments,
  workProducts,
  resolveAuthor,
  isMobile,
  className,
}: IssueFilesDrawerProps) {
  const { files, links } = useMemo(
    () => buildIssueFileEntries(attachments, workProducts),
    [attachments, workProducts],
  );
  const count = files.length + links.length;

  const [open, setOpen] = useState(false);
  const [width, setWidth] = useState<number>(() => readStoredWidth());
  const [dragging, setDragging] = useState(false);
  const widthRef = useRef(width);
  widthRef.current = width;
  const dragStateRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);
  const previousUserSelectRef = useRef("");

  const endDrag = useCallback((persist: boolean) => {
    if (dragStateRef.current === null) return;
    dragStateRef.current = null;
    setDragging(false);
    document.body.style.userSelect = previousUserSelectRef.current;
    if (persist) persistWidth(widthRef.current);
  }, []);

  const handleGripPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    // Primary button only (touch/pen report button 0 or -1 for down events).
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    try {
      // Keeps the drag responsive if the pointer leaves the 8px grip during a
      // fast move. Not universally supported (and jsdom in tests has no real
      // implementation) — the width math below still works via plain
      // bubbling either way, so a failure here is harmless.
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Ignored — see comment above.
    }
    dragStateRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: widthRef.current,
    };
    previousUserSelectRef.current = document.body.style.userSelect;
    document.body.style.userSelect = "none";
    setDragging(true);
  }, []);

  const handleGripPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragStateRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    // The grip sits on the panel's left border: moving left widens the panel.
    setWidth(clampWidth(drag.startWidth + (drag.startX - event.clientX)));
  }, []);

  const handleGripPointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragStateRef.current;
      if (drag === null || drag.pointerId !== event.pointerId) return;
      endDrag(true);
    },
    [endDrag],
  );

  useEffect(
    () => () => {
      if (dragStateRef.current !== null) {
        document.body.style.userSelect = previousUserSelectRef.current;
      }
    },
    [],
  );

  return (
    <>
      {/* A plain button, not SheetTrigger: the shared Sheet stays a pure
      open/close primitive (Sheet/SheetContent only) so it matches every
      other Sheet usage in this codebase (e.g. IssueDetail's mobile
      properties drawer), including how the vendor's own IssueDetail test
      suite mocks "@/components/ui/sheet" — that mock has no SheetTrigger. */}
      <Button
        variant="ghost"
        size="xs"
        disabled={count === 0}
        data-testid="issue-files-drawer-trigger"
        aria-label={`Task files (${count})`}
        className={cn("mr-1 shrink-0 gap-1", className)}
        onClick={() => setOpen(true)}
      >
        <Paperclip className="h-3.5 w-3.5" />
        Files ({count})
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side={isMobile ? "bottom" : "right"}
          data-testid="issue-files-drawer"
          className={cn(
            "gap-0 p-0",
            isMobile
              ? "h-(--sz-85dvh) max-h-(--sz-85dvh) w-full max-w-none pb-(--sz-safe-bottom)"
              : "sm:max-w-none",
          )}
          style={isMobile ? undefined : { width, minWidth: MIN_WIDTH, maxWidth: MAX_WIDTH }}
        >
          {!isMobile ? (
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize files panel"
              data-testid="issue-files-drawer-grip"
              data-dragging={dragging ? "" : undefined}
              className="group absolute inset-y-0 z-10 cursor-col-resize touch-none"
              style={{ left: -4, width: 8 }}
              onPointerDown={handleGripPointerDown}
              onPointerMove={handleGripPointerMove}
              onPointerUp={handleGripPointerUp}
              onPointerCancel={handleGripPointerUp}
              onLostPointerCapture={() => endDrag(true)}
            >
              <div
                className={cn(
                  "mx-auto h-full w-px transition-colors",
                  dragging ? "bg-ring" : "bg-transparent group-hover:bg-ring",
                )}
              />
            </div>
          ) : null}
          <SheetHeader className="border-b border-border">
            <SheetTitle>Files ({count})</SheetTitle>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            <IssueFilesPanel
              attachments={attachments}
              workProducts={workProducts}
              resolveAuthor={resolveAuthor}
              onFileCommentClick={isMobile ? () => setOpen(false) : undefined}
            />
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
