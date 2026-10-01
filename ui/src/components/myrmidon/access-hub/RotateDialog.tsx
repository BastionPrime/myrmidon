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
import type { AccessRecord, RotateInput } from "./accessHubApi";

export type RotateMode = "new-value" | "external";

export interface RotateDialogBodyProps {
  record: AccessRecord;
  busy?: boolean;
  error?: string | null;
  onSubmit: (input: RotateInput) => Promise<unknown> | unknown;
  onCancel: () => void;
}

/**
 * Rotation of one access. Rotating either writes a new value or re-reads the
 * value from the external source; either way the operator decides whether the
 * containers that use the secret are restarted now.
 */
export function RotateDialogBody({ record, busy = false, error = null, onSubmit, onCancel }: RotateDialogBodyProps) {
  const [mode, setMode] = useState<RotateMode>("external");
  const [value, setValue] = useState("");
  const [restartContainers, setRestartContainers] = useState(true);
  const [validationError, setValidationError] = useState<string | null>(null);

  async function submit() {
    if (mode === "new-value" && !value) {
      setValidationError("Enter the new value.");
      return;
    }
    setValidationError(null);
    try {
      await onSubmit(
        mode === "new-value" ? { value, restartContainers } : { external: true, restartContainers },
      );
      setValue("");
    } catch {
      // Reported through `error`; the field keeps what was typed for a retry.
    }
  }

  return (
    <form
      data-testid="access-hub-rotate-form"
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <p className="text-sm text-muted-foreground">
        Rotating <span className="font-medium text-foreground">{record.name}</span> moves it to v
        {record.latestVersion + 1}.
      </p>

      <fieldset className="flex flex-col gap-1">
        <legend className="text-sm text-muted-foreground">New value comes from</legend>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name="access-hub-rotate-source"
            checked={mode === "external"}
            onChange={() => setMode("external")}
            aria-label="External source"
          />
          The external source of this reference
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name="access-hub-rotate-source"
            checked={mode === "new-value"}
            onChange={() => setMode("new-value")}
            aria-label="Value typed here"
          />
          A value I type here
        </label>
      </fieldset>

      {mode === "new-value" ? (
        <label className="flex flex-col gap-1 text-sm">
          New value
          <Input
            type="password"
            autoComplete="new-password"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            aria-label="New value"
            data-testid="access-hub-rotate-value-input"
          />
        </label>
      ) : null}

      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={restartContainers}
          onChange={(event) => setRestartContainers(event.target.checked)}
          aria-label="Restart affected containers"
          className="mt-1"
        />
        <span>
          Restart the containers that use this access
          <span className="block text-xs text-muted-foreground">
            They are restarted one after another in a short maintenance window; each restart takes the new value
            with it. Leave this off to keep running containers on the old value until their next start.
          </span>
        </span>
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
          Rotate access
        </Button>
      </DialogFooter>
    </form>
  );
}

export interface RotateDialogProps extends RotateDialogBodyProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function RotateDialog({ open, onOpenChange, ...body }: RotateDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rotate access</DialogTitle>
          <DialogDescription>
            A rotation bumps the version. Values are never displayed, here or afterwards.
          </DialogDescription>
        </DialogHeader>
        <RotateDialogBody {...body} />
      </DialogContent>
    </Dialog>
  );
}