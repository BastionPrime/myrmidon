// ui/src/ui2/screens/settings/system/Ui2SystemSettings.tsx
//
// myrmidon(UI2): Settings → "Channels, access and the change log" in the
// new shell. Existing APIs only: accessApi.listMembers (roles/status),
// accessApi.listBoardApiKeys (scoped keys with prefix/last-used/revoked),
// activityApi.list (the change log). The mock's per-entry "Rollback"
// buttons are NOT implemented: the vendor API has no settings rollback
// (map §2.15, risk 15 — first slice is read-only for the log). The
// response-channel selector (auto/web/telegram) is a CTO-CHAT dependency
// and stays hidden.

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { accessApi } from "@/api/access";
import { activityApi } from "@/api/activity";
import { queryKeys } from "@/lib/queryKeys";
import { useCompany } from "@/context/CompanyContext";
import { formatDateTime } from "@/lib/utils";
import { useUi2I18n } from "../../../i18n/Ui2I18n";
import {
  Ui2DeniedState,
  Ui2EmptyStateView,
  Ui2ErrorState,
  Ui2SkeletonRows,
} from "../../../components/ui2StateViews";
import {
  Ui2Page,
  Ui2Section,
  Ui2StatusDot,
} from "../../../components/ui2Primitives";
// myrmidon(OPE-3789): the Telegram notifications panel (TG-NOTIFY part F)
// — five editable sections plus the settings change log, all off by default.
import { Ui2TelegramNotifySettings } from "./Ui2TelegramNotifySettings";

const CHANGE_LOG_LIMIT = 30;

export function Ui2SystemSettings() {
  const { t } = useUi2I18n();
  const { selectedCompanyId } = useCompany();
  const companyId = selectedCompanyId ?? "";

  const membersQuery = useQuery({
    queryKey: queryKeys.access.companyMembers(companyId),
    queryFn: () => accessApi.listMembers(companyId),
    enabled: !!selectedCompanyId,
    staleTime: 30_000,
  });

  const keysQuery = useQuery({
    queryKey: queryKeys.access.boardApiKeys(false),
    queryFn: () => accessApi.listBoardApiKeys({ includeInactive: false }),
    enabled: !!selectedCompanyId,
    staleTime: 30_000,
  });

  const activityQuery = useQuery({
    queryKey: [...queryKeys.activity(companyId), "ui2-changelog", CHANGE_LOG_LIMIT],
    queryFn: () => activityApi.list(companyId, { limit: CHANGE_LOG_LIMIT }),
    enabled: !!selectedCompanyId,
    staleTime: 30_000,
  });

  const memberRows = useMemo(
    () =>
      (membersQuery.data?.members ?? []).map((member) => ({
        id: member.id,
        name: member.user?.name ?? member.user?.email ?? member.principalId,
        role: member.membershipRole ?? "member",
        status: member.status,
      })),
    [membersQuery.data],
  );

  if (membersQuery.isLoading) {
    return (
      <Ui2Page title={t("ui2.settings.system.title")} subtitle={t("ui2.settings.system.subtitle")}>
        <Ui2SkeletonRows rows={4} />
      </Ui2Page>
    );
  }

  const membersDenied =
    membersQuery.isError && (membersQuery.error as { status?: number } | null)?.status === 403;

  if (membersQuery.isError) {
    return (
      <Ui2Page title={t("ui2.settings.system.title")} subtitle={t("ui2.settings.system.subtitle")}>
        {membersDenied ? (
          <Ui2DeniedState
            message={t("ui2.settings.system.denied")}
            hint={t("ui2.settings.system.deniedHint")}
          />
        ) : (
          <Ui2ErrorState
            message={t("ui2.common.error")}
            detail={membersQuery.error instanceof Error ? membersQuery.error.message : null}
            retryLabel={t("ui2.common.retry")}
            onRetry={() => void membersQuery.refetch()}
          />
        )}
      </Ui2Page>
    );
  }

  return (
    <Ui2Page title={t("ui2.settings.system.title")} subtitle={t("ui2.settings.system.subtitle")}>
      <Ui2Section title={t("ui2.settings.system.channels.title")}>
        <div className="ui2-channel flex items-center gap-3 rounded-md border border-border p-3">
          <Ui2StatusDot tone="ok" />
          <div className="flex flex-col">
            <span className="ui2-channel-name text-sm font-medium">{t("ui2.settings.system.channels.web")}</span>
          </div>
        </div>
      </Ui2Section>

      {/* myrmidon(OPE-3789): the Telegram notifications panel — the TG-NOTIFY-SETTINGS
          settings screen (part F), rendered as a section of the Channels screen. */}
      <Ui2TelegramNotifySettings />

      <Ui2Section title={t("ui2.settings.system.members.title")}>
        {memberRows.length === 0 ? (
          <Ui2EmptyStateView variant="done" title={t("ui2.settings.system.members.empty")} />
        ) : (
          <table className="ui2-members w-full text-sm">
            <thead>
              <tr className="ui2-members-head text-left text-xs text-muted-foreground">
                <th className="ui2-members-name py-1 font-medium">{t("ui2.settings.system.members.role")}</th>
                <th className="ui2-members-role py-1 font-medium">{t("ui2.settings.system.members.role")}</th>
                <th className="ui2-members-status py-1 font-medium">{t("ui2.settings.system.members.status")}</th>
              </tr>
            </thead>
            <tbody>
              {memberRows.map((member) => (
                <tr key={member.id} className="ui2-members-row border-t border-border">
                  <td className="ui2-member-name py-1.5">{member.name}</td>
                  <td className="ui2-member-role py-1.5">{member.role}</td>
                  <td className="ui2-member-status py-1.5">
                    <span className="inline-flex items-center gap-2">
                      <Ui2StatusDot tone={member.status === "active" ? "ok" : member.status === "pending" ? "warning" : "muted"} />
                      {member.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Ui2Section>

      <Ui2Section title={t("ui2.settings.system.keys.title")}>
        {keysQuery.isLoading ? (
          <Ui2SkeletonRows rows={2} dense />
        ) : (keysQuery.data ?? []).length === 0 ? (
          <Ui2EmptyStateView variant="done" title={t("ui2.settings.system.keys.empty")} />
        ) : (
          <div className="ui2-keys flex flex-col gap-2">
            {(keysQuery.data ?? []).map((key) => (
              <div key={key.id} className="ui2-key flex flex-wrap items-center justify-between gap-3 rounded-md border border-border p-3">
                <div className="ui2-key-info flex flex-col gap-1">
                  <span className="ui2-key-name text-sm font-medium">{key.name}</span>
                  <span className="ui2-key-scope font-mono text-xs text-muted-foreground">{key.scope.kind}</span>
                </div>
                <div className="ui2-key-meta flex flex-col items-end gap-1 text-xs text-muted-foreground">
                  <span className="ui2-key-created">
                    {t("ui2.settings.system.keys.created")}: {formatDateTime(key.createdAt)}
                  </span>
                  <span className="ui2-key-last-used">
                    {t("ui2.settings.system.keys.lastUsed")}:{" "}
                    {key.lastUsedAt ? formatDateTime(key.lastUsedAt) : t("ui2.settings.system.keys.never")}
                  </span>
                  {key.revokedAt ? <span className="ui2-key-revoked text-destructive">{t("ui2.settings.system.keys.revoked")}</span> : null}
                  {key.expiresAt ? (
                    <span className="ui2-key-expires">{t("ui2.settings.system.keys.expires", { when: formatDateTime(key.expiresAt) })}</span>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        )}
      </Ui2Section>

      <Ui2Section title={t("ui2.settings.system.changelog.title")}>
        {activityQuery.isLoading ? (
          <Ui2SkeletonRows rows={3} dense />
        ) : (activityQuery.data ?? []).length === 0 ? (
          <Ui2EmptyStateView variant="done" title={t("ui2.settings.system.changelog.empty")} />
        ) : (
          <ol className="ui2-changelog flex flex-col gap-2">
            {(activityQuery.data ?? []).map((event) => (
              <li key={event.id} className="ui2-changelog-entry flex flex-col gap-0.5 border-b border-border pb-2 last:border-b-0 last:pb-0">
                <span className="ui2-changelog-action font-mono text-xs">{event.action}</span>
                <span className="ui2-changelog-meta text-xs text-muted-foreground">
                  {event.createdAt ? formatDateTime(event.createdAt) : ""}
                  {event.agentId ? ` · ${t("ui2.settings.system.changelog.actor", { actor: event.agentId })}` : ""}
                </span>
              </li>
            ))}
          </ol>
        )}
      </Ui2Section>
    </Ui2Page>
  );
}
