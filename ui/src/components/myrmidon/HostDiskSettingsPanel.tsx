// Host disk usage (BOT-DISK E): the threshold and the live numbers of the disk
// the server's data lives on, editable while it runs. Saving applies at once
// — the sweep re-reads the threshold on every measurement, no restart.
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { HardDrive } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { hostDiskApi, hostDiskQueryKey, type HostDiskView } from "./hostDiskApi";

function formatGrowth(bytesPerHour: number | null): string {
  if (bytesPerHour === null) return "Not enough samples yet";
  const gbPerHour = bytesPerHour / (1024 * 1024 * 1024);
  if (gbPerHour >= 1) return `+${gbPerHour.toFixed(1)} GB/hour`;
  if (gbPerHour > 0) return `+${(gbPerHour * 1024).toFixed(0)} MB/hour`;
  if (gbPerHour === 0) return "Stable";
  return `${gbPerHour.toFixed(1)} GB/hour`;
}

export function HostDiskSettingsPanel() {
  const queryClient = useQueryClient();
  const { data: view } = useQuery({
    queryKey: hostDiskQueryKey,
    queryFn: hostDiskApi.get,
  });
  const [draft, setDraft] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (view && draft === "") setDraft(String(view.threshold.usageThresholdPercent));
  }, [view, draft]);

  const save = useMutation({
    mutationFn: () => hostDiskApi.update({ usageThresholdPercent: Number(draft) }),
    onSuccess: () => {
      setError(null);
      queryClient.invalidateQueries({ queryKey: hostDiskQueryKey });
    },
    onError: () => setError("Could not save the threshold. Try again."),
  });

  const submit = () => {
    const value = Number(draft);
    if (!Number.isInteger(value) || value < 1 || value > 99) {
      setError("Enter a whole number between 1 and 99");
      return;
    }
    save.mutate();
  };

  const status = view?.status;
  const overThreshold = status?.overThreshold ?? false;

  return (
    <section className="space-y-4 rounded-lg border p-4" data-testid="host-disk-panel">
      <div className="flex items-center gap-2">
        <HardDrive className="size-4 text-muted-foreground" />
        <h3 className="text-sm font-medium">Host disk</h3>
        {overThreshold && (
          <span className="rounded bg-orange-500/15 px-2 py-0.5 text-xs font-medium text-orange-600" data-testid="host-disk-over">
            Over threshold
          </span>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="host-disk-threshold">Alert when the disk is fuller than, %</Label>
        <div className="flex items-center gap-2">
          <Input
            id="host-disk-threshold"
            inputMode="numeric"
            className="w-24"
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              setError(null);
            }}
            data-testid="host-disk-threshold-input"
          />
          <Button size="sm" onClick={submit} disabled={save.isPending || draft === ""}>
            {save.isPending ? "Saving…" : "Save"}
          </Button>
          {view && view.threshold.sources.usageThresholdPercent !== "settings" && (
            <span className="text-xs text-muted-foreground">
              {view.threshold.sources.usageThresholdPercent === "env"
                ? "From the server environment"
                : "Default"}
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          The signal appears in the attention queue when usage crosses this
          level. Applies immediately; the sweep re-reads it on every
          measurement.
        </p>
        {error && <p className="text-xs text-red-600">{error}</p>}
        {save.isSuccess && !error && <p className="text-xs text-green-600">Saved</p>}
      </div>

      {status && (
        <div className="space-y-1 text-sm" data-testid="host-disk-status">
          {status.usage.usedPercent !== null ? (
            <>
              <p>
                <span className="font-medium">{status.usage.usedPercent}%</span> used
                {status.usage.totalGb !== null && ` — ${status.usage.usedGb} of ${status.usage.totalGb} GB (${status.usage.freeGb} GB free)`}
              </p>
              <p className="text-muted-foreground">Growth: {formatGrowth(status.usage.growthBytesPerHour)}</p>
              {status.consumers.length > 0 && (
                <div>
                  <p className="font-medium">Biggest consumers</p>
                  <ul className="list-disc pl-4 text-muted-foreground">
                    {status.consumers.map((consumer) => (
                      <li key={consumer.path}>
                        {consumer.path} — {consumer.sizeGb} GB
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          ) : (
            <p className="text-muted-foreground">No measurement yet.</p>
          )}
        </div>
      )}
    </section>
  );
}

export type { HostDiskView };
