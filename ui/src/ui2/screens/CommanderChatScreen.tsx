// myrmidon(1.6-CTO-CHAT-A): the Commander chat — the portal entry of the
// free-text planning flow. Design note (screen-map §4.3) and the epic split:
// Part A owns the portal screen; the planning endpoint POST
// /api/myrmidon/cto-chat/plan and the suggest_tasks card creation belong to
// Part B and are NOT re-implemented here. This screen:
//   1. resolves the owner's standing Agent Chat issue for the Commander agent
//      (the same `/companies/:id/chats/:agentRef` conversation the card will
//      live in, so the approve/reject flow happens in one thread);
//   2. posts the operator's text to the Part B planner and renders the
//      returned epic draft (tasks, children, acceptance criteria) read-only;
//   3. renders the live suggest_tasks interaction card from that standing
//      issue (IssueThreadInteractionCard), so accept/reject uses the existing
//      interaction pipeline — no second card UI.
// The screen extends the UI-2.0 shell family (ui2 tree behind
// enableMyrmidonUi2), not the conference-room BoardChat: BoardChat is a
// multi-agent conference surface, while the Commander chat is a single
// owner-to-board planning conversation — different surface, own route.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUp, ClipboardList, Loader2 } from "lucide-react";
import { useLocation } from "@/lib/router"; // myrmidon(1.6-CTO-CHAT-A): read the draft query param
import { useCompany } from "@/context/CompanyContext";
import { agentChatsApi } from "@/api/agentChats";
import { agentsApi } from "@/api/agents";
import { authApi } from "@/api/auth";
import { issuesApi } from "@/api/issues";
import { ctoChatApi, type CtoChatPlan } from "@/api/ctoChat";
import { queryKeys } from "@/lib/queryKeys";
import { IssueThreadInteractionCard } from "@/components/IssueThreadInteractionCard";
import { useUi2T } from "@/ui2/i18n/useUi2T";
import type { Issue, IssueThreadInteraction } from "@paperclipai/shared";

/**
 * The agent the Commander conversation is held with. Resolved by role/name so
 * the screen works for any instance that has a "Commander"-ish agent; the
 * palette and the rail both land here.
 */
function isCommanderAgent(agent: { role?: string | null; name?: string | null }): boolean {
  const role = agent.role?.toLowerCase() ?? "";
  if (role === "cto") return true;
  return /commander|полковод/i.test(agent.name ?? "");
}

interface PlanPreviewProps {
  plan: CtoChatPlan;
}

function PlanPreview({ plan }: PlanPreviewProps) {
  const { t } = useUi2T();
  return (
    <section aria-label={t("commanderChat.planAria", { defaultValue: "Proposed plan" })}>
      <header className="mb-1 flex items-center gap-1 text-sm font-semibold">
        <ClipboardList aria-hidden="true" className="size-4" />
        {plan.epic.title}
      </header>
      {plan.epic.description ? (
        <p className="mb-2 text-sm leading-5 text-muted-foreground">{plan.epic.description}</p>
      ) : null}
      <ul className="mb-2 ml-1 list-none space-y-2">
        {plan.tasks.map((task) => (
          <li
            key={task.clientKey}
            className="rounded border border-border/70 bg-surface px-2 py-1.5"
          >
            <div className="flex items-center gap-1">
              {task.parentClientKey ? null : (
                <span className="text-(length:--text-nano) font-medium uppercase tracking-(--tracking-eyebrow) text-muted-foreground">
                  {t("commanderChat.epicLabel", { defaultValue: "Epic" })}
                </span>
              )}
              <span className="text-sm font-medium">{task.title}</span>
            </div>
            {task.description ? (
              <p className="mt-0.5 text-sm leading-5 text-muted-foreground">{task.description}</p>
            ) : null}
            {task.acceptanceCriteria.length > 0 ? (
              <ul className="mt-1 ml-4 list-disc space-y-0.5 text-sm leading-5 text-muted-foreground">
                {task.acceptanceCriteria.map((criterion, index) => (
                  <li key={index}>{criterion}</li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function CommanderChatScreen() {
  const { selectedCompanyId } = useCompany();
  const { t } = useUi2T();
  const client = useQueryClient();
  const location = useLocation();

  const [draft, setDraft] = useState(() =>
    // myrmidon(1.6-CTO-CHAT-A): seed from ?draft= so the palette hand-off
    // does not force the operator to retype the request.
    new URLSearchParams(location.search).get("draft") ?? "",
  );
  const [plan, setPlan] = useState<CtoChatPlan | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [planning, setPlanning] = useState(false);
  const [resolving, setResolving] = useState(false);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);

  const agents = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const session = useQuery({ queryKey: queryKeys.auth.session, queryFn: authApi.getSession });
  const userId = session.data?.user?.id ?? session.data?.session?.userId ?? null;

  const commander = useMemo(
    () => (agents.data ?? []).find((a) => isCommanderAgent(a)) ?? null,
    [agents.data],
  );

  // The standing conversation the suggest_tasks card lands in. The card is
  // created server-side by Part B; the screen only renders whatever pending
  // interactions exist on the issue, and keeps them fresh while one is pending.
  const chatKey = queryKeys.agentChats.detail(selectedCompanyId, userId, commander?.id);
  const chat = useQuery({
    queryKey: chatKey,
    queryFn: () => agentChatsApi.get(selectedCompanyId!, commander!.id),
    enabled: !!selectedCompanyId && !!commander && session.isFetched,
  });
  const chatIssue: Issue | null = chat.data ?? null;

  const interactions = useQuery({
    queryKey: queryKeys.issues.interactions(chatIssue?.id ?? ""),
    queryFn: () => issuesApi.listInteractions(chatIssue!.id),
    enabled: !!chatIssue,
    refetchInterval: (query) => {
      const pending = (query.state.data ?? []).some((i: IssueThreadInteraction) => i.status === "pending");
      return pending ? 5_000 : 20_000;
    },
  });

  const pendingSuggested = useMemo(
    () =>
      (interactions.data ?? []).filter(
        (i) => i.kind === "suggest_tasks" && i.status === "pending",
      ),
    [interactions.data],
  );

  // Accept/reject route through the existing interaction pipeline (Part B's
  // card on this standing issue); after a resolution the issue list itself
  // changed (children were created), so the thread state is refreshed.
  const upsertInteraction = useCallback(
    (interaction: IssueThreadInteraction) => {
      if (!chatIssue) return;
      client.setQueryData<IssueThreadInteraction[]>(
        queryKeys.issues.interactions(chatIssue.id),
        (current) => (current ?? []).map((i) => (i.id === interaction.id ? interaction : i)),
      );
    },
    [client, chatIssue],
  );

  const onAcceptInteraction = useCallback(
    async (interaction: IssueThreadInteraction) => {
      if (!chatIssue) return;
      setResolving(true);
      try {
        const next = await issuesApi.acceptInteraction(chatIssue.id, interaction.id, {});
        upsertInteraction(next);
        await interactions.refetch();
      } finally {
        setResolving(false);
      }
    },
    [chatIssue, upsertInteraction, interactions],
  );

  const onRejectInteraction = useCallback(
    async (interaction: IssueThreadInteraction, reason?: string) => {
      if (!chatIssue) return;
      setResolving(true);
      try {
        const next = await issuesApi.rejectInteraction(chatIssue.id, interaction.id, reason);
        upsertInteraction(next);
        await interactions.refetch();
      } finally {
        setResolving(false);
      }
    },
    [chatIssue, upsertInteraction, interactions],
  );

  useEffect(() => {
    composerRef.current?.focus();
  }, []);

  const submit = useCallback(async () => {
    const text = draft.trim();
    if (!selectedCompanyId || !text || planning) return;
    setPlanning(true);
    setPlanError(null);
    setPlan(null);
    try {
      const result = await ctoChatApi.createPlan(selectedCompanyId, { text, source: { kind: "portal" } });
      setPlan(result);
      setDraft("");
      // The card may land on the standing issue moments later; refresh both.
      await Promise.allSettled([
        client.invalidateQueries({ queryKey: chatKey }),
        interactions.refetch(),
      ]);
    } catch (error) {
      setPlanError(error instanceof Error ? error.message : String(error));
    } finally {
      setPlanning(false);
    }
  }, [draft, selectedCompanyId, planning, client, chatKey, interactions]);

  if (agents.isError) {
    return <p className="text-sm text-destructive">{(agents.error as Error).message}</p>;
  }
  if (agents.isPending || session.isPending) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 aria-hidden="true" className="size-4 animate-spin" />
        {t("commanderChat.loading", { defaultValue: "Loading conversation…" })}
      </p>
    );
  }
  if (!commander) {
    return (
      <p className="text-sm text-muted-foreground">
        {t("commanderChat.noAgent", {
          defaultValue: "No Commander agent found in this company yet.",
        })}
      </p>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-(--breakpoint-md) flex-col gap-4 px-3 py-4">
      <header>
        <h1 className="text-lg font-semibold">
          {t("commanderChat.title", { defaultValue: "Commander chat" })}
        </h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {t("commanderChat.subtitle", {
            defaultValue:
              "Describe what you want in plain text — the board proposes an epic with tasks for your approval.",
          })}
        </p>
      </header>

      {planError ? (
        <p role="alert" className="rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {planError}
        </p>
      ) : null}

      {plan ? <PlanPreview plan={plan} /> : null}

      {pendingSuggested.length > 0 ? (
        <div className="space-y-3">
          {pendingSuggested.map((interaction) => (
            <IssueThreadInteractionCard
              key={interaction.id}
              interaction={interaction}
              onAcceptInteraction={onAcceptInteraction}
              onRejectInteraction={onRejectInteraction}
            />
          ))}
        </div>
      ) : null}

      {resolving ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 aria-hidden="true" className="size-4 animate-spin" />
          {t("commanderChat.resolving", { defaultValue: "Applying your decision…" })}
        </p>
      ) : null}

      <form
        className="mt-auto flex items-end gap-2 rounded border border-border bg-surface p-2"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <textarea
          ref={composerRef}
          rows={3}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={t("commanderChat.placeholder", {
            defaultValue: "Tell the Commander what to build…",
          })}
          aria-label={t("commanderChat.placeholder", {
            defaultValue: "Tell the Commander what to build…",
          })}
          className="min-h-16 flex-1 resize-y rounded bg-transparent px-2 py-1 text-sm outline-none placeholder:text-muted-foreground"
          disabled={planning}
        />
        <button
          type="submit"
          disabled={!draft.trim() || planning}
          aria-label={t("commanderChat.send", { defaultValue: "Build a plan" })}
          className="inline-flex size-9 shrink-0 items-center justify-center rounded bg-primary text-primary-foreground disabled:opacity-50"
        >
          {planning ? (
            <Loader2 aria-hidden="true" className="size-4 animate-spin" />
          ) : (
            <ArrowUp aria-hidden="true" className="size-4" />
          )}
        </button>
      </form>
    </div>
  );
}
