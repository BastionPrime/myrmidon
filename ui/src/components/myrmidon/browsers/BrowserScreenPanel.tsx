// myrmidon(BROWSER-CONSOLE): the screen session panel — timers, the auto-close
// warning, the Done button and the periodic activity heartbeat. The actual
// noVNC view arrives with the screen node (part B); the panel drives the
// session lifecycle and keeps the screen open by reporting activity.

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/api/client";
import { browsersApi, browsersQueryKey, formatDuration } from "./browsersApi";
import type { BrowserConsoleStatus, BrowserScreenStatusResponse } from "@paperclipai/shared/myrmidon-browser-console";

const HEARTBEAT_MS = 30_000;

function readable(error: unknown): string {
  if (error instanceof ApiError) return error.message || `Request failed: ${error.status}`;
  if (error instanceof Error) return error.message;
  return "Unexpected error";
}

export interface ScreenPanelState {
  active: boolean;
  autoCloseAt: number | null;
  warnAt: number | null;
  closedBy: string | null;
  error: string | null;
  remainingMs: number;
}

export function useScreenSession(browser: BrowserConsoleStatus, companyId: string) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<ScreenPanelState>({
    active: false,
    autoCloseAt: null,
    warnAt: null,
    closedBy: null,
    error: null,
    remainingMs: 0,
  });
  const [now, setNow] = useState(Date.now());
  const browserIdRef = useRef(browser.id);
  browserIdRef.current = browser.id;

  const heartbeatMutation = useMutation({
    mutationFn: (activity: boolean) => browsersApi.heartbeat(browserIdRef.current, companyId, activity),
    onMutate: () => setState((current) => ({ ...current, error: null })),
    onSuccess: (result) => {
      if (!result.active) {
        setState({ active: false, autoCloseAt: null, warnAt: null, closedBy: result.closedBy ?? null, error: null, remainingMs: 0 });
        void queryClient.invalidateQueries({ queryKey: browsersQueryKey });
        return;
      }
      setState((current) => ({
        ...current,
        active: true,
        autoCloseAt: result.autoCloseAt ? Date.parse(result.autoCloseAt) : null,
        warnAt: result.warnAt ? Date.parse(result.warnAt) : null,
        closedBy: result.closedBy ?? null,
        remainingMs: result.autoCloseAt ? Math.max(0, Date.parse(result.autoCloseAt) - Date.now()) : 0,
      }));
    },
    onError: (error) => setState((current) => ({ ...current, error: readable(error) })),
  });

  const doneMutation = useMutation({
    mutationFn: () => browsersApi.done(browserIdRef.current, companyId),
    onSuccess: () => {
      setState({ active: false, autoCloseAt: null, warnAt: null, closedBy: "done", error: null, remainingMs: 0 });
      void queryClient.invalidateQueries({ queryKey: browsersQueryKey });
    },
    onError: (error) => setState((current) => ({ ...current, error: readable(error) })),
  });

  // Adopt an existing session (another tab, a page reload).
  const openScreenQuery = useQuery({
    queryKey: ["myrmidon", "browsers", "screen", browser.id],
    queryFn: () => browsersApi.heartbeat(browser.id, companyId, false),
    enabled: browser.sessionActive,
    retry: false,
    refetchOnWindowFocus: false,
  });
  useEffect(() => {
    const result = openScreenQuery.data as (BrowserScreenStatusResponse & { active: boolean }) | undefined;
    if (!result) return;
    if (result.active) {
      setState((current) => ({
        ...current,
        active: true,
        autoCloseAt: result.autoCloseAt ? Date.parse(result.autoCloseAt) : null,
        warnAt: result.warnAt ? Date.parse(result.warnAt) : null,
        closedBy: null,
        remainingMs: result.autoCloseAt ? Math.max(0, Date.parse(result.autoCloseAt) - Date.now()) : 0,
      }));
    }
  }, [openScreenQuery.data]);

  // While the session is live: tick the clock, send keep-alive heartbeats.
  useEffect(() => {
    if (!state.active) return;
    const clock = setInterval(() => {
      setNow(Date.now());
      setState((current) => ({
        ...current,
        remainingMs: current.autoCloseAt !== null ? Math.max(0, current.autoCloseAt - Date.now()) : 0,
      }));
    }, 1_000);
    const beat = setInterval(() => heartbeatMutation.mutate(false), HEARTBEAT_MS);
    return () => {
      clearInterval(clock);
      clearInterval(beat);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.active]);

  // The auto-close warning window: warnAt <= now.
  const warning = state.active && state.warnAt !== null && now >= state.warnAt && state.remainingMs <= 60_000;
  void warning;

  return { state, warning, now, heartbeatMutation, doneMutation };
}

export function BrowserScreenPanelView({
  browserId,
  state,
  warning,
  onActivity,
  onDone,
  donePending,
}: {
  browserId: string;
  state: ScreenPanelState;
  warning: boolean;
  onActivity: () => void;
  onDone: () => void;
  donePending: boolean;
}) {
  if (!state.active) {
    if (state.closedBy === "done") {
      return (
        <p className="text-xs text-muted-foreground" data-testid={`myrmidon-browser-screen-closed-${browserId}`}>
          Screen closed. Bots resumed.
        </p>
      );
    }
    return null;
  }
  return (
    <div className="space-y-2 rounded-md border border-border bg-muted/30 px-3 py-3" data-testid={`myrmidon-browser-screen-${browserId}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm font-medium">Screen session</div>
        <Button size="sm" variant="default" disabled={donePending} onClick={onDone} data-testid={`myrmidon-browser-screen-done-${browserId}`}>
          Done
        </Button>
      </div>
      <div className="text-xs text-muted-foreground">
        Auto-close in {formatDuration(state.remainingMs)} (idle or at the hard limit).
      </div>
      {warning && (
        <p className="text-xs text-amber-500" data-testid={`myrmidon-browser-screen-warning-${browserId}`}>
          The screen closes soon. Press Done when you are finished.
        </p>
      )}
      <div className="text-xs text-muted-foreground">
        Activity: the panel reports activity to keep the idle timer running (mouse and key events arrive with the screen view).
      </div>
      <Button size="sm" variant="outline" onClick={onActivity} data-testid={`myrmidon-browser-screen-activity-${browserId}`}>
        Report activity
      </Button>
      {state.error && <p className="text-xs text-destructive">{state.error}</p>}
    </div>
  );
}

export function BrowserScreenPanel({ browser, companyId }: { browser: BrowserConsoleStatus; companyId: string }) {
  const { state, warning, heartbeatMutation, doneMutation } = useScreenSession(browser, companyId);
  return (
    <BrowserScreenPanelView
      browserId={browser.id}
      state={state}
      warning={warning}
      onActivity={() => heartbeatMutation.mutate(true)}
      onDone={() => doneMutation.mutate()}
      donePending={doneMutation.isPending}
    />
  );
}
