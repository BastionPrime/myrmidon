import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { PageTabBar } from "@/components/PageTabBar";
import { ApiError } from "@/api/client";
import { agentsApi } from "@/api/agents";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useToastActions } from "@/context/ToastContext";
import { copyTextToClipboard } from "@/lib/clipboard";
import { queryKeys } from "@/lib/queryKeys";
import { AccessListView } from "./AccessList";
import { AccessDetailView } from "./AccessDetail";
import { AccessValueDialog, type AccessValueSubmit } from "./AccessValueDialog";
import { SshGenerateDialog } from "./SshGenerateDialog";
import { RotateDialog } from "./RotateDialog";
import { HostDeployDialog, type HostDeployMode } from "./HostDeployDialog";
import { AuditTabView } from "./AuditTab";
import {
  DEFAULT_AUDIT_LIMIT,
  EMPTY_ACCESS_FILTERS,
  accessHubApi,
  accessHubQueryKeys,
  filterAccessRecords,
  sshRevealForSelection,
  type AccessListFilters,
  type GenerateSshInput,
  type RotateInput,
  type SaveSecretValueInput,
  type SshKeyMaterial,
} from "./accessHubApi";

type AccessHubTab = "accesses" | "journal";

type AccessDialog =
  | { kind: "none" }
  | { kind: "create" }
  | { kind: "set-value" }
  | { kind: "rotate" }
  | { kind: "ssh" }
  | { kind: "hosts"; mode: HostDeployMode };

function readable(error: unknown): string {
  if (error instanceof ApiError) return error.message || `Request failed: ${error.status}`;
  if (error instanceof Error) return error.message;
  return "Unexpected error";
}

/**
 * Settings → Access hub. One screen over the access-hub API: the access list,
 * a card per access, the SSH generation/rotation/deploy actions, and the
 * journal.
 *
 * Secrecy rule for this whole subtree: no secret value is ever rendered. The
 * single exception is the public half of an SSH key the operator just
 * generated, which is held in memory only while its own card (or the
 * generation dialog) is open.
 */
export function AccessHubPage() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();
  const queryClient = useQueryClient();

  const [activeTab, setActiveTab] = useState<AccessHubTab>("accesses");
  const [filters, setFilters] = useState<AccessListFilters>(EMPTY_ACCESS_FILTERS);
  const [selectedSecretId, setSelectedSecretId] = useState<string | null>(null);
  const [sshReveal, setSshReveal] = useState<SshKeyMaterial | null>(null);
  const [dialog, setDialog] = useState<AccessDialog>({ kind: "none" });
  const [dialogError, setDialogError] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Access hub" }]);
  }, [setBreadcrumbs]);

  const accessesQuery = useQuery({
    queryKey: accessHubQueryKeys.accesses,
    queryFn: accessHubApi.listAccesses,
    enabled: Boolean(selectedCompanyId),
  });
  const hostsQuery = useQuery({
    queryKey: accessHubQueryKeys.hosts,
    queryFn: accessHubApi.listHosts,
    enabled: Boolean(selectedCompanyId),
  });
  const auditQuery = useQuery({
    queryKey: accessHubQueryKeys.audit,
    queryFn: accessHubApi.audit,
    enabled: Boolean(selectedCompanyId) && activeTab === "journal",
  });
  const agentsQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.agents.list(selectedCompanyId) : ["agents", "__disabled__"],
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const records = accessesQuery.data ?? [];
  const hosts = hostsQuery.data ?? [];
  const agents = useMemo(
    () => (agentsQuery.data ?? []).map((agent) => ({ id: agent.id, name: agent.name })),
    [agentsQuery.data],
  );
  const visibleRecords = useMemo(() => filterAccessRecords(records, filters), [records, filters]);
  const selectedRecord = useMemo(
    () => records.find((record) => record.secretId === selectedSecretId) ?? null,
    [records, selectedSecretId],
  );
  const visibleSshReveal = sshRevealForSelection(sshReveal, selectedSecretId);

  function invalidateAccessHub() {
    void queryClient.invalidateQueries({ queryKey: accessHubQueryKeys.accesses });
    void queryClient.invalidateQueries({ queryKey: accessHubQueryKeys.audit });
  }

  /**
   * Keeping the reveal tied to the lifetime of one card: any other selection
   * (or closing the card) drops the generated public key, so a reopened card
   * shows its fingerprint alone.
   */
  function openRecord(secretId: string) {
    setSshReveal((current) => (current && current.secretId === secretId ? current : null));
    setSelectedSecretId(secretId);
  }

  function closeRecord() {
    setSelectedSecretId(null);
    setSshReveal(null);
  }

  function openDialog(next: AccessDialog) {
    setDialogError(null);
    setDialog(next);
  }

  function closeDialog() {
    setDialogError(null);
    setDialog({ kind: "none" });
  }

  function copyPublicKey(publicKey: string) {
    void copyTextToClipboard(publicKey)
      .then(() => pushToast({ title: "Public key copied", tone: "success" }))
      .catch((error) =>
        pushToast({
          title: "Copy failed",
          body: readable(error),
          tone: "error",
        }),
      );
  }

  const valueMutation = useMutation({
    mutationFn: (payload: AccessValueSubmit) => {
      const input: SaveSecretValueInput = { ...payload };
      return accessHubApi.saveSecretValue(input);
    },
    onSuccess: (result, payload) => {
      pushToast({
        title: payload.secretId ? "Value replaced" : "Access created",
        body: payload.secretId ? undefined : payload.name,
        tone: "success",
      });
      closeDialog();
      invalidateAccessHub();
      if (payload.secretId) openRecord(payload.secretId);
    },
    onError: (error) => setDialogError(readable(error)),
  });

  const rotateMutation = useMutation({
    mutationFn: ({ secretId, input }: { secretId: string; input: RotateInput }) =>
      accessHubApi.rotate(secretId, input),
    onSuccess: (result) => {
      pushToast({
        title: `Rotated to v${result.latestVersion}`,
        body:
          result.restartedContainers && result.restartedContainers.length > 0
            ? `Restarted: ${result.restartedContainers.join(", ")}`
            : "No container needed a restart.",
        tone: "success",
      });
      closeDialog();
      invalidateAccessHub();
    },
    onError: (error) => setDialogError(readable(error)),
  });

  const sshMutation = useMutation({
    mutationFn: (input: GenerateSshInput) => accessHubApi.generateSshKey(input),
    onSuccess: (material) => {
      // The dialog switches to its reveal view and the card behind it keeps
      // the public half until it is closed — no fetch, no persistence.
      setSshReveal(material);
      setSelectedSecretId(material.secretId);
      invalidateAccessHub();
      pushToast({ title: "SSH key generated", body: "Copy the public half now — it is shown once.", tone: "success" });
    },
    onError: (error) => setDialogError(readable(error)),
  });

  const grantMutation = useMutation({
    mutationFn: ({ secretId, targetAgentId }: { secretId: string; targetAgentId: string }) =>
      accessHubApi.grant(secretId, targetAgentId),
    onSuccess: () => {
      pushToast({ title: "Access granted", tone: "success" });
      invalidateAccessHub();
    },
    onError: (error) => pushToast({ title: "Grant failed", body: readable(error), tone: "error" }),
  });

  const revokeMutation = useMutation({
    mutationFn: ({ secretId, targetAgentId }: { secretId: string; targetAgentId: string }) =>
      accessHubApi.revoke(secretId, targetAgentId),
    onSuccess: () => {
      pushToast({ title: "Access revoked", tone: "info" });
      invalidateAccessHub();
    },
    onError: (error) => pushToast({ title: "Revoke failed", body: readable(error), tone: "error" }),
  });

  const hostRefsMutation = useMutation({
    mutationFn: ({ secretId, hostRefs }: { secretId: string; hostRefs: string[] }) =>
      accessHubApi.setHostRefs(secretId, hostRefs),
    onSuccess: (_result, variables) => {
      pushToast({ title: "Host set updated", body: `${variables.hostRefs.length} host(s) hold this access.`, tone: "info" });
      closeDialog();
      invalidateAccessHub();
    },
    onError: (error) => setDialogError(readable(error)),
  });

  if (!selectedCompanyId) {
    return <div className="p-6 text-sm text-muted-foreground">Select an organization to manage accesses.</div>;
  }

  const listError = accessesQuery.isError ? readable(accessesQuery.error) : null;

  return (
    <div className="flex max-w-6xl flex-col gap-4">
      <div className="flex items-center gap-2">
        <KeyRound className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-lg font-semibold">Access hub</h1>
      </div>

      <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as AccessHubTab)} className="flex flex-col gap-4">
        <PageTabBar
          items={[
            { value: "accesses", label: "Accesses" },
            { value: "journal", label: "Journal" },
          ]}
          align="start"
          value={activeTab}
          onValueChange={(value) => setActiveTab(value as AccessHubTab)}
        />

        <TabsContent value="accesses" className="flex flex-col gap-3">
          <AccessListView
            records={visibleRecords}
            hosts={hosts}
            agents={agents}
            filters={filters}
            loading={accessesQuery.isPending}
            error={listError}
            onFiltersChange={setFilters}
            onSelect={openRecord}
            onCreate={() => openDialog({ kind: "create" })}
          />
        </TabsContent>

        <TabsContent value="journal" className="flex flex-col gap-3">
          <AuditTabView
            entries={auditQuery.data ?? []}
            limit={DEFAULT_AUDIT_LIMIT}
            loading={auditQuery.isPending}
            error={auditQuery.isError ? readable(auditQuery.error) : null}
          />
        </TabsContent>
      </Tabs>

      <Sheet open={Boolean(selectedRecord)} onOpenChange={(open) => (open ? undefined : closeRecord())}>
        <SheetContent className="flex w-full flex-col gap-4 overflow-y-auto sm:max-w-xl">
          {selectedRecord ? (
            <>
              <SheetHeader>
                <SheetTitle>{selectedRecord.name}</SheetTitle>
                <SheetDescription>Details, references and actions. Secret values are never shown.</SheetDescription>
              </SheetHeader>
              <AccessDetailView
                record={selectedRecord}
                hosts={hosts}
                agents={agents}
                sshPublicKey={visibleSshReveal?.publicKey ?? null}
                busy={
                  rotateMutation.isPending ||
                  valueMutation.isPending ||
                  grantMutation.isPending ||
                  revokeMutation.isPending ||
                  hostRefsMutation.isPending ||
                  sshMutation.isPending
                }
                onSetValue={() => openDialog({ kind: "set-value" })}
                onRotate={() => openDialog({ kind: "rotate" })}
                onGenerateSsh={() => openDialog({ kind: "ssh" })}
                onDeployHosts={() => openDialog({ kind: "hosts", mode: "deploy" })}
                onWithdrawHosts={() => openDialog({ kind: "hosts", mode: "withdraw" })}
                onGrant={(targetAgentId) =>
                  grantMutation.mutate({ secretId: selectedRecord.secretId, targetAgentId })
                }
                onRevoke={(targetAgentId) =>
                  revokeMutation.mutate({ secretId: selectedRecord.secretId, targetAgentId })
                }
                onCopyPublicKey={copyPublicKey}
              />
            </>
          ) : null}
        </SheetContent>
      </Sheet>

      <AccessValueDialog
        open={dialog.kind === "create" || dialog.kind === "set-value"}
        onOpenChange={(open) => (open ? undefined : closeDialog())}
        mode={dialog.kind === "create" ? "create" : "set-value"}
        record={dialog.kind === "set-value" ? selectedRecord : null}
        busy={valueMutation.isPending}
        error={dialogError}
        onSubmit={(payload) => valueMutation.mutateAsync(payload)}
        onCancel={closeDialog}
      />

      <SshGenerateDialog
        open={dialog.kind === "ssh"}
        onOpenChange={(open) => (open ? undefined : closeDialog())}
        hosts={hosts}
        material={sshReveal}
        busy={sshMutation.isPending}
        error={dialogError}
        onGenerate={(input) => sshMutation.mutateAsync(input)}
        onCopyPublicKey={copyPublicKey}
        onClose={closeDialog}
      />

      <RotateDialog
        open={dialog.kind === "rotate"}
        onOpenChange={(open) => (open ? undefined : closeDialog())}
        record={selectedRecord ?? emptyRecord()}
        busy={rotateMutation.isPending}
        error={dialogError}
        onSubmit={(input) =>
          selectedRecord
            ? rotateMutation.mutateAsync({ secretId: selectedRecord.secretId, input })
            : Promise.resolve()
        }
        onCancel={closeDialog}
      />

      <HostDeployDialog
        open={dialog.kind === "hosts"}
        onOpenChange={(open) => (open ? undefined : closeDialog())}
        mode={dialog.kind === "hosts" ? dialog.mode : "deploy"}
        record={selectedRecord ?? emptyRecord()}
        hosts={hosts}
        busy={hostRefsMutation.isPending}
        error={dialogError}
        onSubmit={(hostRefs) =>
          selectedRecord
            ? hostRefsMutation.mutateAsync({ secretId: selectedRecord.secretId, hostRefs })
            : Promise.resolve()
        }
        onCancel={closeDialog}
      />
    </div>
  );
}

// The dialogs are only mounted with a record in hand; this placeholder keeps
// their prop types total while the sheet is closed.
function emptyRecord() {
  return {
    secretId: "",
    name: "",
    key: "",
    kind: "token" as const,
    status: "active",
    latestVersion: 0,
    createdAt: "",
    lastRotatedAt: null,
    bindings: [],
    hostRefs: [],
    fingerprint: null,
  };
}