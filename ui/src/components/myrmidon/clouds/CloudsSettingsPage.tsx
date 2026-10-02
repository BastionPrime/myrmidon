// myrmidon(CLOUD-CONNECTOR): Settings → Clouds page.
// The owner connects a cloud account once, keeps the folders inside it and
// hands each of them to an agent, a caste or everyone with a mode. The token
// stays in the connector; the panel only ever sees the account and its id.

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Cloud } from "lucide-react";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ApiError } from "@/api/client";
import type {
  CloudAccessMode,
  CloudAccount,
  CloudGrant,
  CloudGrantTargetKind,
  CloudJournalEntry,
  CloudProviderId,
  CloudRoot,
  CloudRootKind,
} from "@paperclipai/shared/myrmidon-cloud-connector";
import {
  CLOUD_PROVIDER_LABELS,
  cloudsAccountsQueryKey,
  cloudsApi,
  cloudsGrantsQueryKey,
  cloudsJournalQueryKey,
  cloudsRootsQueryKey,
  grantTargetLabel,
  rootKindLabel,
  type NewGrantInput,
  type NewRootInput,
} from "./cloudsApi";

const SELECT_CLASS = "h-9 w-full rounded-md border border-input bg-background px-2 text-sm";

export function readable(error: unknown): string {
  if (error instanceof ApiError) return error.message || `Request failed: ${error.status}`;
  if (error instanceof Error) return error.message;
  return "Unexpected error";
}

export interface CloudsSettingsPageViewProps {
  companyId: string;
  accounts: CloudAccount[];
  roots: CloudRoot[];
  grants: CloudGrant[];
  journal: CloudJournalEntry[];
  loading: boolean;
  error: string | null;
  notice: string | null;
  pending: boolean;
  onConnect: (providerId: CloudProviderId) => void;
  onDisconnect: (accountId: string) => void;
  onAddRoot: (input: NewRootInput) => void;
  onRemoveRoot: (rootId: string) => void;
  onSetGrant: (input: NewGrantInput) => void;
  onRemoveGrant: (grantId: string) => void;
}

function AccountsSection({ accounts, pending, onConnect, onDisconnect }: Pick<CloudsSettingsPageViewProps, "accounts" | "pending" | "onConnect" | "onDisconnect">) {
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold">Connected accounts</h2>
      <p className="text-xs text-muted-foreground">
        The connector keeps the cloud token; no bot ever sees it. One account per provider.
      </p>
      <ul className="space-y-2" data-testid="myrmidon-clouds-accounts">
        {CLOUD_PROVIDER_LABELS.map(({ id, label }) => {
          const account = accounts.find((entry) => entry.providerId === id);
          return (
            <li
              key={id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2"
              data-testid={`myrmidon-clouds-provider-${id}`}
            >
              <div className="space-y-0.5">
                <p className="text-sm">{label}</p>
                <p className="text-xs text-muted-foreground" data-testid={`myrmidon-clouds-provider-state-${id}`}>
                  {account
                    ? `Connected as ${account.displayName} on ${new Date(account.connectedAt).toLocaleDateString()}`
                    : "Not connected"}
                </p>
              </div>
              {account ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() => onDisconnect(account.id)}
                  data-testid={`myrmidon-clouds-disconnect-${id}`}
                >
                  Disconnect
                </Button>
              ) : (
                <Button
                  size="sm"
                  disabled={pending}
                  onClick={() => onConnect(id)}
                  data-testid={`myrmidon-clouds-connect-${id}`}
                >
                  Connect
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function AddFolderForm({ pending, onAddRoot }: Pick<CloudsSettingsPageViewProps, "pending" | "onAddRoot">) {
  const [providerId, setProviderId] = useState<CloudProviderId>("onedrive");
  const [name, setName] = useState("");
  const [kind, setKind] = useState<CloudRootKind>("own");
  const [folder, setFolder] = useState("");
  const [driveId, setDriveId] = useState("");
  const [itemId, setItemId] = useState("");

  const canSubmit = name.trim().length > 0 && (kind === "own" ? folder.trim().length > 0 : driveId.trim().length > 0 && itemId.trim().length > 0);

  return (
    <div className="space-y-2 rounded-md border border-border p-3" data-testid="myrmidon-clouds-add-folder">
      <div className="grid gap-2 sm:grid-cols-3">
        <label className="space-y-1 text-xs text-muted-foreground">
          Cloud
          <select
            className={SELECT_CLASS}
            value={providerId}
            onChange={(event) => setProviderId(event.target.value as CloudProviderId)}
            aria-label="Cloud provider"
            data-testid="myrmidon-clouds-new-folder-provider"
          >
            {CLOUD_PROVIDER_LABELS.map(({ id, label }) => (
              <option key={id} value={id}>{label}</option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">
          Folder name
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="work"
            aria-label="Folder name"
            data-testid="myrmidon-clouds-new-folder-name"
          />
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">
          Where it lives
          <select
            className={SELECT_CLASS}
            value={kind}
            onChange={(event) => setKind(event.target.value as CloudRootKind)}
            aria-label="Folder kind"
            data-testid="myrmidon-clouds-new-folder-kind"
          >
            <option value="own">In the connected account</option>
            <option value="shared">Shared with us (read only)</option>
          </select>
        </label>
      </div>
      {kind === "own" ? (
        <label className="space-y-1 text-xs text-muted-foreground">
          Path inside the account drive
          <Input
            value={folder}
            onChange={(event) => setFolder(event.target.value)}
            placeholder="Agents/work"
            aria-label="Folder path"
            data-testid="myrmidon-clouds-new-folder-path"
          />
        </label>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="space-y-1 text-xs text-muted-foreground">
            Drive id
            <Input
              value={driveId}
              onChange={(event) => setDriveId(event.target.value)}
              aria-label="Drive id"
              data-testid="myrmidon-clouds-new-folder-drive"
            />
          </label>
          <label className="space-y-1 text-xs text-muted-foreground">
            Item id
            <Input
              value={itemId}
              onChange={(event) => setItemId(event.target.value)}
              aria-label="Item id"
              data-testid="myrmidon-clouds-new-folder-item"
            />
          </label>
        </div>
      )}
      <Button
        size="sm"
        disabled={pending || !canSubmit}
        onClick={() => {
          onAddRoot(
            kind === "own"
              ? { providerId, name: name.trim(), kind, folder: folder.trim() }
              : { providerId, name: name.trim(), kind, driveId: driveId.trim(), itemId: itemId.trim() },
          );
          setName("");
          setFolder("");
          setDriveId("");
          setItemId("");
        }}
        data-testid="myrmidon-clouds-add-folder-button"
      >
        Add folder
      </Button>
    </div>
  );
}

function GrantsSection({
  roots,
  grants,
  pending,
  onSetGrant,
  onRemoveGrant,
}: Pick<CloudsSettingsPageViewProps, "roots" | "grants" | "pending" | "onSetGrant" | "onRemoveGrant">) {
  const [rootId, setRootId] = useState("");
  const [targetKind, setTargetKind] = useState<CloudGrantTargetKind>("all");
  const [agentId, setAgentId] = useState("");
  const [caste, setCaste] = useState("");
  const [mode, setMode] = useState<CloudAccessMode>("ro");

  const selectedRoot = roots.find((root) => root.id === rootId) ?? roots[0];
  const canSubmit =
    roots.length > 0
    && (targetKind !== "agent" || agentId.trim().length > 0)
    && (targetKind !== "caste" || caste.trim().length > 0);

  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold">Access</h2>
      <p className="text-xs text-muted-foreground">
        Each row hands one folder to an agent, a caste or everyone. A folder shared with us can only be read.
      </p>
      <div className="space-y-2 rounded-md border border-border p-3" data-testid="myrmidon-clouds-add-grant">
        <div className="grid gap-2 sm:grid-cols-4">
          <label className="space-y-1 text-xs text-muted-foreground">
            Folder
            <select
              className={SELECT_CLASS}
              value={selectedRoot?.id ?? ""}
              onChange={(event) => setRootId(event.target.value)}
              aria-label="Folder"
              data-testid="myrmidon-clouds-grant-root"
            >
              {roots.map((root) => (
                <option key={root.id} value={root.id}>{root.name}</option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-xs text-muted-foreground">
            Give to
            <select
              className={SELECT_CLASS}
              value={targetKind}
              onChange={(event) => setTargetKind(event.target.value as CloudGrantTargetKind)}
              aria-label="Grant target"
              data-testid="myrmidon-clouds-grant-target"
            >
              <option value="all">Everyone</option>
              <option value="agent">One agent</option>
              <option value="caste">A caste</option>
            </select>
          </label>
          {targetKind === "agent" && (
            <label className="space-y-1 text-xs text-muted-foreground">
              Agent id
              <Input
                value={agentId}
                onChange={(event) => setAgentId(event.target.value)}
                aria-label="Agent id"
                data-testid="myrmidon-clouds-grant-agent"
              />
            </label>
          )}
          {targetKind === "caste" && (
            <label className="space-y-1 text-xs text-muted-foreground">
              Caste
              <Input
                value={caste}
                onChange={(event) => setCaste(event.target.value)}
                aria-label="Caste"
                data-testid="myrmidon-clouds-grant-caste"
              />
            </label>
          )}
          <label className="space-y-1 text-xs text-muted-foreground">
            Mode
            <select
              className={SELECT_CLASS}
              value={mode}
              onChange={(event) => setMode(event.target.value as CloudAccessMode)}
              aria-label="Grant mode"
              data-testid="myrmidon-clouds-grant-mode"
            >
              <option value="ro">Read only</option>
              <option value="rw">Read and write</option>
            </select>
          </label>
        </div>
        <Button
          size="sm"
          disabled={pending || !canSubmit || !selectedRoot}
          onClick={() => {
            if (!selectedRoot) return;
            onSetGrant(
              targetKind === "agent"
                ? { rootId: selectedRoot.id, targetKind, agentId: agentId.trim(), mode }
                : targetKind === "caste"
                  ? { rootId: selectedRoot.id, targetKind, caste: caste.trim(), mode }
                  : { rootId: selectedRoot.id, targetKind, mode },
            );
            setAgentId("");
            setCaste("");
          }}
          data-testid="myrmidon-clouds-add-grant-button"
        >
          Grant access
        </Button>
      </div>
      {grants.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="myrmidon-clouds-grants-empty">
          No folder is shared with anyone yet.
        </p>
      ) : (
        <ul className="space-y-1" data-testid="myrmidon-clouds-grants">
          {grants.map((grant) => (
            <li
              key={grant.id}
              className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm"
              data-testid="myrmidon-clouds-grant-row"
            >
              <span>
                {roots.find((root) => root.id === grant.rootId)?.name ?? grant.rootId} · {grantTargetLabel(grant)} ·{" "}
                {grant.mode === "rw" ? "read and write" : "read only"}
              </span>
              <Button
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={() => onRemoveGrant(grant.id)}
                data-testid={`myrmidon-clouds-remove-grant-${grant.id}`}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function JournalSection({ journal }: Pick<CloudsSettingsPageViewProps, "journal">) {
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold">Journal</h2>
      {journal.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="myrmidon-clouds-journal-empty">
          No cloud operation yet.
        </p>
      ) : (
        <ul className="space-y-1 text-xs text-muted-foreground" data-testid="myrmidon-clouds-journal">
          {journal.map((entry) => (
            <li key={entry.id} data-testid="myrmidon-clouds-journal-entry">
              {new Date(entry.at).toLocaleString()} · {entry.actor} · {entry.tool} · {entry.rootName ?? "—"} ·{" "}
              {entry.ok ? "ok" : "refused"}
              {entry.detail ? ` · ${entry.detail}` : ""}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function CloudsSettingsPageView(props: CloudsSettingsPageViewProps) {
  return (
    <div className="space-y-6" data-testid="myrmidon-clouds-page">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Cloud className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Clouds</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Connect a cloud once and hand folders to agents. Tokens stay in the connector; agents only reach what is
          granted to them, and every operation lands in the journal.
        </p>
      </div>

      {props.error && (
        <p className="text-xs text-destructive" data-testid="myrmidon-clouds-error">{props.error}</p>
      )}
      {props.notice && (
        <p className="text-xs text-muted-foreground" data-testid="myrmidon-clouds-notice">{props.notice}</p>
      )}
      {props.loading && (
        <p className="text-xs text-muted-foreground" data-testid="myrmidon-clouds-loading">Loading…</p>
      )}

      <AccountsSection
        accounts={props.accounts}
        pending={props.pending}
        onConnect={props.onConnect}
        onDisconnect={props.onDisconnect}
      />

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Folders</h2>
        <p className="text-xs text-muted-foreground">
          A folder is either a path inside the connected account or a folder somebody shared with it (read only).
        </p>
        <AddFolderForm pending={props.pending} onAddRoot={props.onAddRoot} />
        {props.roots.length === 0 ? (
          <p className="text-xs text-muted-foreground" data-testid="myrmidon-clouds-roots-empty">
            No folder yet.
          </p>
        ) : (
          <ul className="space-y-1" data-testid="myrmidon-clouds-roots">
            {props.roots.map((root) => (
              <li
                key={root.id}
                className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm"
                data-testid="myrmidon-clouds-root-row"
              >
                <span>
                  {root.name} · {rootKindLabel(root)} · {root.kind === "shared" ? `${root.driveId ?? "?"}/${root.itemId ?? "?"}` : root.folder ?? "—"}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={props.pending}
                  onClick={() => props.onRemoveRoot(root.id)}
                  data-testid={`myrmidon-clouds-remove-root-${root.id}`}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <GrantsSection
        roots={props.roots}
        grants={props.grants}
        pending={props.pending}
        onSetGrant={props.onSetGrant}
        onRemoveGrant={props.onRemoveGrant}
      />

      <JournalSection journal={props.journal} />
    </div>
  );
}

export function CloudsSettingsPage() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const companyId = selectedCompanyId ?? "";
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Settings", href: "/company/settings" }, { label: "Clouds" }]);
  }, [setBreadcrumbs]);

  const accountsQuery = useQuery({
    queryKey: [...cloudsAccountsQueryKey, companyId],
    queryFn: () => cloudsApi.accounts(companyId),
    enabled: companyId.length > 0,
  });
  const rootsQuery = useQuery({
    queryKey: [...cloudsRootsQueryKey, companyId],
    queryFn: () => cloudsApi.roots(companyId),
    enabled: companyId.length > 0,
  });
  const grantsQuery = useQuery({
    queryKey: [...cloudsGrantsQueryKey, companyId],
    queryFn: () => cloudsApi.grants(companyId),
    enabled: companyId.length > 0,
  });
  const journalQuery = useQuery({
    queryKey: [...cloudsJournalQueryKey, companyId],
    queryFn: () => cloudsApi.journal(companyId),
    enabled: companyId.length > 0,
  });

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: cloudsAccountsQueryKey }),
      queryClient.invalidateQueries({ queryKey: cloudsRootsQueryKey }),
      queryClient.invalidateQueries({ queryKey: cloudsGrantsQueryKey }),
      queryClient.invalidateQueries({ queryKey: cloudsJournalQueryKey }),
    ]);
  };

  const connectMutation = useMutation({
    mutationFn: (providerId: CloudProviderId) => cloudsApi.startConnect(providerId, companyId),
    onSuccess: (started) => {
      // The cloud signs the owner in on its own page and sends the browser back
      // to the callback, which records the account.
      window.open(started.authorizeUrl, "_blank", "noopener");
      setNotice(`Finish the sign-in for ${started.providerId} in the new tab.`);
    },
    onError: (error) => setNotice(readable(error)),
  });
  const disconnectMutation = useMutation({
    mutationFn: (accountId: string) => cloudsApi.disconnectAccount(accountId, companyId),
    onSuccess: () => void refresh(),
    onError: (error) => setNotice(readable(error)),
  });
  const addRootMutation = useMutation({
    mutationFn: (input: NewRootInput) => cloudsApi.addRoot(companyId, input),
    onSuccess: () => void refresh(),
    onError: (error) => setNotice(readable(error)),
  });
  const removeRootMutation = useMutation({
    mutationFn: (rootId: string) => cloudsApi.removeRoot(rootId, companyId),
    onSuccess: () => void refresh(),
    onError: (error) => setNotice(readable(error)),
  });
  const setGrantMutation = useMutation({
    mutationFn: (input: NewGrantInput) => cloudsApi.setGrant(companyId, input),
    onSuccess: () => void refresh(),
    onError: (error) => setNotice(readable(error)),
  });
  const removeGrantMutation = useMutation({
    mutationFn: (grantId: string) => cloudsApi.removeGrant(grantId, companyId),
    onSuccess: () => void refresh(),
    onError: (error) => setNotice(readable(error)),
  });

  const pending =
    connectMutation.isPending
    || disconnectMutation.isPending
    || addRootMutation.isPending
    || removeRootMutation.isPending
    || setGrantMutation.isPending
    || removeGrantMutation.isPending;

  const errorSource = accountsQuery.error ?? rootsQuery.error ?? grantsQuery.error ?? journalQuery.error;

  return (
    <CloudsSettingsPageView
      companyId={companyId}
      accounts={accountsQuery.data?.accounts ?? []}
      roots={rootsQuery.data?.roots ?? []}
      grants={grantsQuery.data?.grants ?? []}
      journal={journalQuery.data?.entries ?? []}
      loading={accountsQuery.isLoading || rootsQuery.isLoading || grantsQuery.isLoading}
      error={errorSource ? readable(errorSource) : null}
      notice={notice}
      pending={pending}
      onConnect={(providerId) => connectMutation.mutate(providerId)}
      onDisconnect={(accountId) => disconnectMutation.mutate(accountId)}
      onAddRoot={(input) => addRootMutation.mutate(input)}
      onRemoveRoot={(rootId) => removeRootMutation.mutate(rootId)}
      onSetGrant={(input) => setGrantMutation.mutate(input)}
      onRemoveGrant={(grantId) => removeGrantMutation.mutate(grantId)}
    />
  );
}