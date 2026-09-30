import { Copy, KeyRound, RefreshCw, Server, ServerOff, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  ACCESS_KIND_LABEL,
  formatAccessMoment,
  grantedAgents,
  hostNamesFor,
  usedByBindings,
  type AccessHost,
  type AccessRecord,
} from "./accessHubApi";
import { GrantRevokeControls } from "./GrantRevokeControls";
import type { AccessAgentOption } from "./AccessList";

export interface AccessDetailViewProps {
  record: AccessRecord;
  hosts: AccessHost[];
  agents: AccessAgentOption[];
  /**
   * Public half of a key generated in this session. Present only while this
   * record's card is open; reopening the card shows the fingerprint alone.
   */
  sshPublicKey?: string | null;
  busy?: boolean;
  onSetValue: () => void;
  onRotate: () => void;
  onGenerateSsh: () => void;
  onDeployHosts: () => void;
  onWithdrawHosts: () => void;
  onGrant: (targetAgentId: string) => void;
  onRevoke: (targetAgentId: string) => void;
  onCopyPublicKey: (publicKey: string) => void;
}

function DetailField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-sm text-foreground">{children}</span>
    </div>
  );
}

/**
 * The secret card. It shows references, versions, timestamps and the public
 * SSH fingerprint — never a secret value. The only credential material that
 * can appear here is the public half of a key the operator just generated.
 */
export function AccessDetailView({
  record,
  hosts,
  agents,
  sshPublicKey = null,
  busy = false,
  onSetValue,
  onRotate,
  onGenerateSsh,
  onDeployHosts,
  onWithdrawHosts,
  onGrant,
  onRevoke,
  onCopyPublicKey,
}: AccessDetailViewProps) {
  const usages = usedByBindings(record);
  const hostNames = hostNamesFor(record, hosts);

  return (
    <div className="flex flex-col gap-4" data-testid="access-hub-detail">
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <KeyRound className="h-4 w-4 text-muted-foreground" />
          <span className="text-base font-semibold text-foreground">{record.name}</span>
          <Badge variant="outline">{ACCESS_KIND_LABEL[record.kind]}</Badge>
          <span className="text-xs text-muted-foreground">{record.status}</span>
        </div>
        <span className="font-mono text-xs text-muted-foreground">{record.key}</span>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <DetailField label="Version">
          <span className="font-mono">v{record.latestVersion}</span>
        </DetailField>
        <DetailField label="Created">
          <span className="font-mono">{formatAccessMoment(record.createdAt)}</span>
        </DetailField>
        <DetailField label="Last rotated">
          <span className="font-mono">{formatAccessMoment(record.lastRotatedAt)}</span>
        </DetailField>
        <DetailField label="Public fingerprint">
          <span className="font-mono">{record.fingerprint ?? "—"}</span>
        </DetailField>
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">Used by</span>
        {usages.length === 0 && hostNames.length === 0 ? (
          <span className="text-sm text-muted-foreground">Not used anywhere yet.</span>
        ) : (
          <ul className="flex flex-col gap-0.5 text-sm">
            {usages.map((binding) => (
              <li key={`${binding.targetType}:${binding.targetId}`} className="min-w-0 truncate">
                {binding.targetName}
                <span className="text-muted-foreground"> · {binding.targetType}</span>
                {binding.configPath ? (
                  <span className="font-mono text-xs text-muted-foreground"> · {binding.configPath}</span>
                ) : null}
              </li>
            ))}
            {hostNames.length > 0 ? (
              <li className="text-muted-foreground">Hosts: {hostNames.join(", ")}</li>
            ) : null}
          </ul>
        )}
      </div>

      {sshPublicKey ? (
        <div className="flex flex-col gap-2 rounded-md border border-border bg-muted/40 p-3" data-testid="access-hub-public-key">
          <span className="text-xs text-muted-foreground">
            Public key — shown once. Add it to the target host&apos;s authorized keys before leaving this card.
          </span>
          <span className="break-all font-mono text-xs text-foreground">{sshPublicKey}</span>
          <span className="font-mono text-xs text-muted-foreground">
            Fingerprint: {record.fingerprint ?? "—"}
          </span>
          <Button size="sm" variant="outline" onClick={() => onCopyPublicKey(sshPublicKey)}>
            <Copy className="mr-1 h-3.5 w-3.5" /> Copy public key
          </Button>
        </div>
      ) : null}

      <Separator />

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" disabled={busy} onClick={onSetValue}>
          Change value
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={onRotate}>
          <RefreshCw className="mr-1 h-3.5 w-3.5" /> Rotate
        </Button>
        {record.kind === "ssh_key" ? (
          <Button size="sm" variant="outline" disabled={busy} onClick={onGenerateSsh}>
            <Sparkles className="mr-1 h-3.5 w-3.5" /> Generate new key
          </Button>
        ) : null}
        <Button size="sm" variant="outline" disabled={busy} onClick={onDeployHosts}>
          <Server className="mr-1 h-3.5 w-3.5" /> Deploy to hosts
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || record.hostRefs.length === 0}
          onClick={onWithdrawHosts}
        >
          <ServerOff className="mr-1 h-3.5 w-3.5" /> Withdraw from hosts
        </Button>
      </div>

      <Separator />

      <div className="flex flex-col gap-2">
        <span className="text-xs text-muted-foreground">Granted to agents</span>
        <GrantRevokeControls
          agents={agents}
          granted={grantedAgents(record)}
          busy={busy}
          onGrant={onGrant}
          onRevoke={onRevoke}
        />
      </div>
    </div>
  );
}