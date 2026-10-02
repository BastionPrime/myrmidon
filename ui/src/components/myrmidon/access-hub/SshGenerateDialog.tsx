import { useState } from "react";
import { Copy } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { AccessHost, GenerateSshInput, SshKeyMaterial } from "./accessHubApi";

export interface SshGenerateDialogBodyProps {
  hosts: AccessHost[];
  material?: SshKeyMaterial | null;
  busy?: boolean;
  error?: string | null;
  onGenerate: (input: GenerateSshInput) => Promise<unknown> | unknown;
  onCopyPublicKey: (publicKey: string) => void;
  onClose: () => void;
}

/**
 * SSH key generation. The public half and its fingerprint are shown once, in
 * this dialog; only the fingerprint survives on the card afterwards.
 *
 * Generating and deploying are one step: the selected hosts receive the new
 * public key with the same call.
 */
export function SshGenerateDialogBody({
  hosts,
  material = null,
  busy = false,
  error = null,
  onGenerate,
  onCopyPublicKey,
  onClose,
}: SshGenerateDialogBodyProps) {
  const [name, setName] = useState("");
  const [selectedHosts, setSelectedHosts] = useState<string[]>([]);
  const [validationError, setValidationError] = useState<string | null>(null);

  function toggleHost(hostId: string) {
    setSelectedHosts((current) =>
      current.includes(hostId) ? current.filter((id) => id !== hostId) : [...current, hostId],
    );
  }

  async function submit() {
    if (!name.trim()) {
      setValidationError("Give the key a name.");
      return;
    }
    setValidationError(null);
    try {
      await onGenerate({ name: name.trim(), hostRefs: selectedHosts });
    } catch {
      // Failure is reported through the `error` prop; the form stays as typed.
    }
  }

  if (material) {
    return (
      <div className="flex flex-col gap-3" data-testid="access-hub-ssh-material">
        <p className="text-sm text-muted-foreground">
          Public key — shown once. Copy it to every selected host now; the card keeps the fingerprint only.
        </p>
        <span className="break-all font-mono text-xs text-foreground">{material.publicKey}</span>
        <span className="font-mono text-xs text-muted-foreground">Fingerprint: {material.fingerprint}</span>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onCopyPublicKey(material.publicKey)}>
            <Copy className="mr-1 h-3.5 w-3.5" /> Copy public key
          </Button>
          <Button type="button" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </div>
    );
  }

  return (
    <form
      data-testid="access-hub-ssh-form"
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <label className="flex flex-col gap-1 text-sm">
        Name
        <Input value={name} onChange={(event) => setName(event.target.value)} aria-label="Key name" />
      </label>

      <fieldset className="flex flex-col gap-1">
        <legend className="text-sm text-muted-foreground">Deploy the public key to</legend>
        {hosts.length === 0 ? (
          <p className="text-xs text-muted-foreground">No hosts in the registry yet — the key can be deployed later.</p>
        ) : (
          hosts.map((host) => (
            <label key={host.hostId} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={selectedHosts.includes(host.hostId)}
                onChange={() => toggleHost(host.hostId)}
                aria-label={`Deploy to ${host.name}`}
              />
              {host.name}
            </label>
          ))
        )}
      </fieldset>

      {(validationError ?? error) ? (
        <p role="alert" className="text-sm text-destructive">
          {validationError ?? error}
        </p>
      ) : null}

      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy}>
          Generate key
        </Button>
      </DialogFooter>
    </form>
  );
}

export interface SshGenerateDialogProps extends SshGenerateDialogBodyProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SshGenerateDialog({ open, onOpenChange, ...body }: SshGenerateDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Generate SSH key</DialogTitle>
          <DialogDescription>
            Myrmidon creates the pair, keeps the private half and hands you the public half once.
          </DialogDescription>
        </DialogHeader>
        <SshGenerateDialogBody {...body} />
      </DialogContent>
    </Dialog>
  );
}