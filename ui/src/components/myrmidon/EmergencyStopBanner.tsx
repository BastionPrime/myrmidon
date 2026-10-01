// myrmidon(EMERGENCY-STOP): a visible emergency stop for the runs a draining
// operator pause (L3) left running. The pause button only says the agent is
// paused; the runs it left finishing are invisible there, and stopping them
// immediately required an undocumented API call. This banner shows on the
// agent detail page whenever the agent is paused AND still has live runs,
// with one confirm-and-stop action.
//
// Strings go through the board's localization mechanism (t(),
// emergencyStopBanner.* keys in every locale file, real translation in ru),
// the same convention maintenanceBanner uses after the localization rework.
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, OctagonX } from "lucide-react";
import { t } from "@/i18n";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { agentsApi } from "@/api/agents";
import { queryKeys } from "@/lib/queryKeys";
import { useToastActions } from "@/context/ToastContext";

const BANNER_CLASS =
  "border border-red-300/70 bg-red-50 text-red-950 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-100";

export function EmergencyStopBannerView({
  agentId,
  agentName,
  companyId,
  liveRunCount,
  isPaused,
}: {
  agentId: string;
  agentName: string;
  companyId?: string | null;
  liveRunCount: number;
  isPaused: boolean;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();

  const emergencyStop = useMutation({
    mutationFn: () => agentsApi.emergencyStop(agentId, companyId ?? undefined),
    onSuccess: (result: { agentId: string; runsCancelled: number }) => {
      setConfirmOpen(false);
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agentId) });
      if (companyId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.liveRuns(companyId) });
        queryClient.invalidateQueries({ queryKey: queryKeys.heartbeats(companyId, agentId) });
      }
      pushToast({
        title: t("emergencyStopBanner.toastTitle"),
        body: t("emergencyStopBanner.toastBody", { count: result.runsCancelled, agent: agentName }),
        tone: "success",
      });
    },
    onError: (err) => {
      pushToast({
        title: t("emergencyStopBanner.toastErrorTitle"),
        body: err instanceof Error ? err.message : String(err),
        tone: "error",
      });
    },
  });

  // Only a draining pause leaves live runs behind: show the banner while the
  // agent is paused and runs are still finishing. An active agent's live runs
  // are its normal work — the operator pauses first, then stops.
  if (!isPaused || liveRunCount === 0) return null;

  return (
    <div
      role="status"
      data-testid="myrmidon-emergency-stop-banner"
      className={`flex flex-wrap items-center gap-3 rounded-md px-3 py-2 text-sm ${BANNER_CLASS}`}
    >
      <OctagonX className="h-4 w-4 shrink-0" />
      <span className="min-w-0 flex-1">
        {t("emergencyStopBanner.banner", { agent: agentName, count: liveRunCount })}
      </span>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setConfirmOpen(true)}
        disabled={emergencyStop.isPending}
        className="border-red-300/70 bg-transparent text-red-950 hover:bg-red-100 dark:border-red-500/30 dark:text-red-100 dark:hover:bg-red-500/20"
      >
        {emergencyStop.isPending ? (
          <Loader2 className="h-3.5 w-3.5 sm:mr-1 animate-spin" />
        ) : (
          <OctagonX className="h-3.5 w-3.5 sm:mr-1" />
        )}
        <span>{t("emergencyStopBanner.action")}</span>
      </Button>
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("emergencyStopBanner.confirmTitle", { count: liveRunCount, agent: agentName })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("emergencyStopBanner.confirmDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("emergencyStopBanner.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => emergencyStop.mutate()}
              className="border-red-300/70 bg-transparent text-red-950 hover:bg-red-100 dark:border-red-500/30 dark:text-red-100 dark:hover:bg-red-500/20"
            >
              {t("emergencyStopBanner.confirmAction")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
