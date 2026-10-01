import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
import { BOARD_API_KEY_SCOPE_KINDS, type BoardApiKeyScopeKind } from "@paperclipai/shared";
import { accessApi, type BoardApiKeyRecord, type CreatedBoardApiKey } from "@/api/access";
import { ApiError } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useToast } from "@/context/ToastContext";
import { copyTextToClipboard } from "@/lib/clipboard";
import { queryKeys } from "@/lib/queryKeys";

// myrmidon(ROLE-SCOPED-TOKENS): instance settings screen for board API keys.
// Lists every key of the signed-in board user with its scope, creates keys
// with a chosen scope, and revokes keys. The plaintext token of a newly
// created key is rendered exactly once and never refetched.

const SCOPE_HINTS: Record<BoardApiKeyScopeKind, string> = {
  full: "Unrestricted operator access (legacy default)",
  read_only: "Read-only: every GET, no mutations",
  ops: "Read + maintenance, connections, plugins",
  agents_manage: "Read + agent and invite management",
  secrets_manage: "Read + secrets and secret providers",
  release: "Read + issues, work products, attachments",
};

function readable(error: unknown): string {
  if (error instanceof ApiError) return error.message || `Request failed: ${error.status}`;
  if (error instanceof Error) return error.message;
  return "Unexpected error";
}

export function BoardApiKeysPage() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();

  const [includeInactive, setIncludeInactive] = useState(false);
  const [newName, setNewName] = useState("");
  const [newScope, setNewScope] = useState<BoardApiKeyScopeKind>("read_only");
  const [created, setCreated] = useState<CreatedBoardApiKey | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([
      { label: "Settings", href: "/company/settings" },
      { label: "Instance settings", href: "/company/settings/instance/general" },
      { label: "Board API keys" },
    ]);
  }, [setBreadcrumbs]);

  const keysQuery = useQuery({
    queryKey: queryKeys.access.boardApiKeys(includeInactive),
    queryFn: () => accessApi.listBoardApiKeys({ includeInactive }),
  });

  const createMutation = useMutation({
    mutationFn: () =>
      accessApi.createBoardApiKey({
        name: newName.trim() || "board key",
        scope: { kind: newScope },
      }),
    onSuccess: async (record) => {
      setCreated(record);
      setCreateError(null);
      setNewName("");
      await queryClient.invalidateQueries({ queryKey: queryKeys.access.boardApiKeys(includeInactive) });
      pushToast({ title: "Board API key created", body: "Copy the token now — it is shown once.", tone: "success" });
    },
    onError: (error) => setCreateError(readable(error)),
  });

  const revokeMutation = useMutation({
    mutationFn: (keyId: string) => accessApi.revokeBoardApiKey(keyId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.access.boardApiKeys(includeInactive) });
      pushToast({ title: "Board API key revoked", tone: "success" });
    },
    onError: (error) => pushToast({ title: "Revoke failed", body: readable(error), tone: "error" }),
  });

  const keys = keysQuery.data ?? [];

  return (
    <div className="space-y-4 p-4 md:p-6">
      <div className="flex items-center gap-2">
        <KeyRound className="size-4 text-muted-foreground" />
        <h1 className="text-base font-semibold">Board API keys</h1>
      </div>
      <p className="text-sm text-muted-foreground">
        Keys authenticate the board API for this user. Each key carries a scope limiting which
        admin actions it may perform; keys without a scope keep full access.
      </p>

      <Card className="space-y-4 p-4">
        <h2 className="text-sm font-semibold">Create key</h2>
        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="board-key-name">Name</Label>
            <Input
              id="board-key-name"
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              placeholder="release duty"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="board-key-scope">Scope</Label>
            <Select value={newScope} onValueChange={(value) => setNewScope(value as BoardApiKeyScopeKind)}>
              <SelectTrigger id="board-key-scope">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {BOARD_API_KEY_SCOPE_KINDS.map((kind) => (
                  <SelectItem key={kind} value={kind}>
                    {kind}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{SCOPE_HINTS[newScope]}</p>
          </div>
        </div>
        {createError ? <p className="text-sm text-destructive">{createError}</p> : null}
        <div className="flex justify-end">
          <Button onClick={() => createMutation.mutate()} disabled={createMutation.isPending}>
            {createMutation.isPending ? "Creating…" : "Create key"}
          </Button>
        </div>

        {created ? (
          <div className="space-y-2 rounded-lg border border-border p-3">
            <p className="text-sm font-medium">{created.name}</p>
            <p className="text-xs text-muted-foreground">
              scope: {created.scope.kind} • copy the token now, it is shown once
            </p>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 text-xs">
                {created.token}
              </code>
              <Button
                variant="outline"
                onClick={() => {
                  void copyTextToClipboard(created.token);
                  pushToast({ title: "Token copied", tone: "success" });
                }}
              >
                Copy
              </Button>
              <Button variant="ghost" onClick={() => setCreated(null)}>
                Dismiss
              </Button>
            </div>
          </div>
        ) : null}
      </Card>

      <Card className="space-y-3 p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Keys</h2>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={includeInactive}
              onChange={(event) => setIncludeInactive(event.target.checked)}
            />
            show revoked and expired
          </label>
        </div>
        {keysQuery.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : keysQuery.isError ? (
          <p className="text-sm text-destructive">{readable(keysQuery.error)}</p>
        ) : keys.length === 0 ? (
          <p className="text-sm text-muted-foreground">No board API keys yet.</p>
        ) : (
          <div className="space-y-2">
            {keys.map((key: BoardApiKeyRecord) => (
              <div
                key={key.id}
                className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-sm"
              >
                <div className="min-w-0">
                  <div className="font-medium">{key.name}</div>
                  <div className="text-muted-foreground">
                    scope: {key.scope?.kind ?? "full"} • created{" "}
                    {new Date(key.createdAt).toLocaleDateString()}
                    {key.lastUsedAt
                      ? ` • last used ${new Date(key.lastUsedAt).toLocaleDateString()}`
                      : ""}
                    {key.revokedAt ? " • revoked" : ""}
                    {key.expiresAt ? ` • expires ${new Date(key.expiresAt).toLocaleDateString()}` : ""}
                  </div>
                </div>
                {!key.revokedAt ? (
                  <Button
                    variant="outline"
                    onClick={() => revokeMutation.mutate(key.id)}
                    disabled={revokeMutation.isPending}
                  >
                    Revoke
                  </Button>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
