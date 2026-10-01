import { useState } from "react";
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
import {
  ACCESS_KIND_LABEL,
  ACCESS_KIND_ORDER,
  type AccessKind,
  type AccessRecord,
} from "./accessHubApi";

export type AccessValueMode = "create" | "set-value";

export interface AccessValueSubmit {
  /** Absent when creating. */
  secretId?: string;
  name?: string;
  key?: string;
  kind?: AccessKind;
  /** Sent once; never echoed back and never kept in component state. */
  value: string;
}

export interface AccessValueDialogBodyProps {
  mode: AccessValueMode;
  record?: AccessRecord | null;
  busy?: boolean;
  error?: string | null;
  onSubmit: (payload: AccessValueSubmit) => Promise<unknown> | unknown;
  onCancel: () => void;
}

/**
 * Value entry for the access hub: one form for both jobs — creating an access
 * and replacing the value of an existing one.
 *
 * The value lives in this form's state only until the submit resolves, then
 * the field is cleared. It is never rendered as text, never stored in a
 * surrounding state, and never comes back from the API.
 */
export function AccessValueDialogBody({
  mode,
  record = null,
  busy = false,
  error = null,
  onSubmit,
  onCancel,
}: AccessValueDialogBodyProps) {
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [kind, setKind] = useState<AccessKind>("token");
  const [value, setValue] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);

  const creating = mode === "create";

  async function submit() {
    if (creating && !name.trim()) {
      setValidationError("Give the access a name.");
      return;
    }
    if (!value) {
      setValidationError("Enter a value.");
      return;
    }
    setValidationError(null);
    try {
      await onSubmit(
        creating
          ? { name: name.trim(), key: key.trim() || undefined, kind, value }
          : { secretId: record?.secretId, value },
      );
      // The submitted value must not stay on screen (or in the DOM) after the
      // write — the operator gets a version bump and nothing else.
      setValue("");
      if (creating) {
        setName("");
        setKey("");
      }
    } catch {
      // The parent surfaces the failure; keep the field as typed so the
      // operator can retry without re-entering the value from scratch.
    }
  }

  return (
    <form
      data-testid="access-hub-value-form"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      className="flex flex-col gap-3"
    >
      {creating ? (
        <>
          <label className="flex flex-col gap-1 text-sm">
            Name
            <Input value={name} onChange={(event) => setName(event.target.value)} aria-label="Access name" />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Key
            <Input
              value={key}
              onChange={(event) => setKey(event.target.value)}
              aria-label="Access key"
              placeholder="derived from the name when empty"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Type
            <select
              value={kind}
              aria-label="Access type"
              onChange={(event) => setKind(event.target.value as AccessKind)}
              className="h-8 rounded-md border border-border bg-background px-2 text-sm text-foreground"
            >
              {ACCESS_KIND_ORDER.map((option) => (
                <option key={option} value={option}>
                  {ACCESS_KIND_LABEL[option]}
                </option>
              ))}
            </select>
          </label>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          New value for <span className="font-medium text-foreground">{record?.name}</span> (
          <span className="font-mono text-xs">{record?.key}</span>). The current version stays readable until the
          write lands.
        </p>
      )}

      <label className="flex flex-col gap-1 text-sm">
        Value
        <Input
          type="password"
          autoComplete="new-password"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          aria-label="Secret value"
          data-testid="access-hub-value-input"
        />
      </label>

      {(validationError ?? error) ? (
        <p role="alert" className="text-sm text-destructive">
          {validationError ?? error}
        </p>
      ) : null}

      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy}>
          {creating ? "Create access" : "Save value"}
        </Button>
      </DialogFooter>
    </form>
  );
}

export interface AccessValueDialogProps extends AccessValueDialogBodyProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AccessValueDialog({ open, onOpenChange, ...body }: AccessValueDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{body.mode === "create" ? "New access" : "Change value"}</DialogTitle>
          <DialogDescription>
            The value is written once and is never displayed again — after this it only appears as a version number.
          </DialogDescription>
        </DialogHeader>
        <AccessValueDialogBody {...body} />
      </DialogContent>
    </Dialog>
  );
}