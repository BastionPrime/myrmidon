// myrmidon(EXTCASE-PANEL): the operator panel of the client connectors.
//
// Company settings → Connectors. Four surfaces, the way the design note §4.4
// slices them:
//   - the device list with its status (online, last seen) and pairing;
//   - the domain allowlist (read for everyone, write for instance admins);
//   - the signing policy: mode auto / manual / per action type, the daily
//     limit, and the kill switch;
//   - the journal of actions and signatures, with filters.
//
// The panel talks only to the board routes of the bridge; the bridge token of
// a device never passes through it, and the pairing code is shown exactly
// once — when the operator just issued it.
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Cable, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCompany } from "@/context/CompanyContext";
import { useTranslation } from "@/i18n";
import {
  bridgeApi,
  bridgeDevicesQueryKey,
  bridgeJournalQueryKey,
  bridgeSettingsQueryKey,
  describeSeenAt,
  type BridgeJournalQuery,
  type BridgeJournalRow,
  type BridgeSettings,
  type BridgeDeviceView,
} from "./connectorPanelApi";

const SELECT_CLASS = "h-9 w-full rounded-md border border-input bg-background px-2 text-sm";

const JOURNAL_METHODS = [
  "browser.open",
  "browser.read",
  "browser.click",
  "browser.fill",
  "browser.download",
  "browser.screenshot",
  "browser.sign",
] as const;

const JOURNAL_OUTCOMES = ["ok", "denied", "timeout", "error"] as const;

/** Parse the allowlist textarea into domains, keeping only bare hostnames. */
export function parseAllowlistDraft(raw: string): string[] {
  const seen = new Set<string>();
  for (const line of raw.split(/[\n,]+/)) {
    const value = line.trim().toLowerCase().replace(/\.$/, "");
    if (!value) continue;
    if (value.includes("://") || value.includes("/") || value.includes(":") || value.includes("*")) continue;
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(value)) continue;
    seen.add(value);
  }
  return [...seen].sort();
}

/** Parse the daily-limit draft: empty = no limit, else a positive whole number. */
export function parseDailyLimitDraft(raw: string): { value: number | null; error: string | null } {
  const trimmed = raw.trim();
  if (!trimmed) return { value: 0, error: null };
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return { value: null, error: "Enter a whole number greater than zero, or leave it empty" };
  }
  return { value: parsed, error: null };
}

export interface ConnectorPanelViewProps {
  devices: BridgeDeviceView[] | undefined;
  settings: BridgeSettings | undefined;
  journalRows: BridgeJournalRow[] | undefined;
  signedToday: number | null;
  journalLoading: boolean;
  pairingPending: boolean;
  savePending: boolean;
  killSwitchPending: boolean;
  revokePending: string | null;
  lastPairingCode: { code: string; expiresAt: string } | null;
  error: string | null;
  nowMs?: number;
  onIssuePairing?: (label?: string) => void;
  onRevokeDevice?: (deviceId: string) => void;
  onSaveSettings?: (patch: { domains: string[]; signing: BridgeSettings["signing"] }) => void;
  onKillSwitch?: () => void;
}

export function ConnectorPanelView({
  devices,
  settings,
  journalRows,
  signedToday,
  journalLoading,
  pairingPending,
  savePending,
  killSwitchPending,
  revokePending,
  lastPairingCode,
  error,
  nowMs = Date.now(),
  onIssuePairing,
  onRevokeDevice,
  onSaveSettings,
  onKillSwitch,
}: ConnectorPanelViewProps) {
  const { t } = useTranslation();
  const [allowlistDraft, setAllowlistDraft] = useState<string | null>(null);
  const [signingMode, setSigningMode] = useState<BridgeSettings["signing"]["mode"] | null>(null);
  const [signingTypes, setSigningTypes] = useState<string | null>(null);
  const [dailyLimitDraft, setDailyLimitDraft] = useState<string | null>(null);
  const [pairingLabel, setPairingLabel] = useState("");
  const [journalDevice, setJournalDevice] = useState("");
  const [journalMethod, setJournalMethod] = useState("");
  const [journalOutcome, setJournalOutcome] = useState("");
  const [journalSignaturesOnly, setJournalSignaturesOnly] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);

  const domains = allowlistDraft ?? (settings ? settings.domains.join("\n") : "");
  const mode = signingMode ?? settings?.signing.mode ?? "auto";
  const types = signingTypes ?? settings?.signing.types.join(", ") ?? "";
  const dailyLimit = dailyLimitDraft ?? (settings ? String(settings.signing.dailyLimit || "") : "");
  const dailyLimitParsed = parseDailyLimitDraft(dailyLimit);
  const dirty =
    allowlistDraft !== null ||
    signingMode !== null ||
    signingTypes !== null ||
    dailyLimitDraft !== null;

  const journalDevices = useMemo(() => {
    const map = new Map<string, string>();
    for (const device of devices ?? []) {
      map.set(device.deviceId, device.label ?? device.deviceId);
    }
    return map;
  }, [devices]);

  return (
    <section className="space-y-4" data-testid="myrmidon-connector-panel">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Cable className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">{t("connectorPanel.title")}</h2>
        </div>
        <p className="max-w-2xl text-sm text-muted-foreground">{t("connectorPanel.intro")}</p>
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      {/* Devices and pairing */}
      <div className="space-y-2" data-testid="connector-panel-devices">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t("connectorPanel.devices.title")}
        </h3>
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <Label htmlFor="connector-pairing-label">{t("connectorPanel.devices.pairingLabel")}</Label>
            <Input
              id="connector-pairing-label"
              placeholder="tender-ops"
              className="w-48"
              value={pairingLabel}
              onChange={(event) => setPairingLabel(event.target.value)}
            />
          </div>
          <Button
            type="button"
            size="sm"
            disabled={pairingPending}
            onClick={() => {
              onIssuePairing?.(pairingLabel.trim() || undefined);
            }}
          >
            {pairingPending ? t("connectorPanel.devices.issuing") : t("connectorPanel.devices.issue")}
          </Button>
        </div>
        {lastPairingCode ? (
          <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm" data-testid="connector-panel-pairing-code">
            <span className="mr-2 font-mono text-base tracking-wider">{lastPairingCode.code}</span>
            <span className="text-xs text-muted-foreground">
              {t("connectorPanel.devices.expiresAt", { time: new Date(lastPairingCode.expiresAt).toLocaleTimeString() })}
            </span>
          </div>
        ) : null}
        {devices && devices.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="connector-panel-device-table">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="py-1 pr-4">{t("connectorPanel.devices.device")}</th>
                  <th className="py-1 pr-4">{t("connectorPanel.devices.status")}</th>
                  <th className="py-1 pr-4">{t("connectorPanel.devices.lastSeen")}</th>
                  <th className="py-1 pr-4">{t("connectorPanel.devices.version")}</th>
                  <th className="py-1 pr-4">{t("connectorPanel.devices.capabilities")}</th>
                  <th className="py-1" />
                </tr>
              </thead>
              <tbody>
                {devices.map((device) => (
                  <tr key={device.deviceId} className="border-b last:border-0">
                    <td className="py-1.5 pr-4 font-medium">
                      {device.label ?? device.deviceId}
                      <div className="text-xs text-muted-foreground">{device.deviceId}</div>
                    </td>
                    <td className="py-1.5 pr-4">
                      <span data-testid={`connector-device-status-${device.deviceId}`} className={device.connected ? "text-green-600" : "text-muted-foreground"}>
                        {device.connected ? t("connectorPanel.devices.online") : t("connectorPanel.devices.offline")}
                      </span>
                    </td>
                    <td className="py-1.5 pr-4" data-testid={`connector-device-lastseen-${device.deviceId}`}>
                      {describeSeenAt(device.lastSeenAt, nowMs)}
                    </td>
                    <td className="py-1.5 pr-4 text-muted-foreground">{device.extVersion}</td>
                    <td className="py-1.5 pr-4 text-xs text-muted-foreground">{device.capabilities.join(", ")}</td>
                    <td className="py-1.5 text-right">
                      {confirmRevoke === device.deviceId ? (
                        <div className="flex justify-end gap-2">
                          <Button
                            type="button"
                            size="sm"
                            variant="destructive"
                            disabled={revokePending === device.deviceId}
                            onClick={() => onRevokeDevice?.(device.deviceId)}
                          >
                            {revokePending === device.deviceId ? t("connectorPanel.devices.revoking") : t("connectorPanel.devices.confirmRevoke")}
                          </Button>
                          <Button type="button" size="sm" variant="outline" onClick={() => setConfirmRevoke(null)}>
                            {t("connectorPanel.devices.cancelRevoke")}
                          </Button>
                        </div>
                      ) : (
                        <Button type="button" size="sm" variant="outline" onClick={() => setConfirmRevoke(device.deviceId)}>
                          {t("connectorPanel.devices.revoke")}
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground" data-testid="connector-panel-no-devices">
            {devices ? t("connectorPanel.devices.none") : t("connectorPanel.devices.loading")}
          </p>
        )}
      </div>

      {/* Allowlist */}
      <div className="space-y-2" data-testid="connector-panel-allowlist">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t("connectorPanel.allowlist.title")}
        </h3>
        <p className="text-sm text-muted-foreground">{t("connectorPanel.allowlist.hint")}</p>
        <textarea
          className="min-h-24 w-full rounded-md border border-input bg-background px-2 py-1.5 font-mono text-sm"
          data-testid="connector-panel-allowlist-input"
          value={domains}
          onChange={(event) => setAllowlistDraft(event.target.value)}
        />
      </div>

      {/* Signing policy */}
      <div className="space-y-2" data-testid="connector-panel-signing">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t("connectorPanel.signing.title")}
        </h3>
        <div className="flex flex-wrap items-center gap-4">
          <div className="space-y-1">
            <Label htmlFor="connector-signing-mode">{t("connectorPanel.signing.mode")}</Label>
            <select
              id="connector-signing-mode"
              className={SELECT_CLASS}
              data-testid="connector-signing-mode"
              value={mode}
              onChange={(event) => setSigningMode(event.target.value as BridgeSettings["signing"]["mode"])}
            >
              <option value="auto">{t("connectorPanel.signing.modeAuto")}</option>
              <option value="manual">{t("connectorPanel.signing.modeManual")}</option>
              <option value="types">{t("connectorPanel.signing.modeTypes")}</option>
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="connector-signing-limit">{t("connectorPanel.signing.dailyLimit")}</Label>
            <Input
              id="connector-signing-limit"
              data-testid="connector-signing-limit"
              inputMode="numeric"
              placeholder={t("connectorPanel.signing.noLimit")}
              className="w-36"
              value={dailyLimit}
              onChange={(event) => setDailyLimitDraft(event.target.value)}
            />
            {dailyLimitParsed.error ? (
              <div className="text-xs text-destructive" data-testid="connector-signing-limit-error">
                {dailyLimitParsed.error}
              </div>
            ) : null}
          </div>
          {signedToday !== null ? (
            <div className="text-xs text-muted-foreground" data-testid="connector-panel-signed-today">
              {t("connectorPanel.signing.signedToday", { count: signedToday })}
            </div>
          ) : null}
        </div>
        {mode === "types" ? (
          <div className="space-y-1">
            <Label htmlFor="connector-signing-types">{t("connectorPanel.signing.types")}</Label>
            <Input
              id="connector-signing-types"
              data-testid="connector-signing-types"
              className="w-96"
              placeholder="tender.submit, tender.bid"
              value={types}
              onChange={(event) => setSigningTypes(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">{t("connectorPanel.signing.typesHint")}</p>
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            size="sm"
            data-testid="connector-panel-save"
            disabled={savePending || !dirty || dailyLimitParsed.error !== null}
            onClick={() => onSaveSettings?.({
              domains: parseAllowlistDraft(domains),
              signing: {
                enabled: settings?.signing.enabled ?? true,
                mode,
                types: types.split(",").map((entry) => entry.trim()).filter(Boolean),
                dailyLimit: dailyLimitParsed.value ?? 0,
              },
            })}
          >
            {savePending ? t("connectorPanel.signing.saving") : t("connectorPanel.signing.save")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="destructive"
            data-testid="connector-panel-kill-switch"
            disabled={killSwitchPending || settings?.signing.enabled === false}
            onClick={() => onKillSwitch?.()}
          >
            <ShieldAlert className="mr-1 h-4 w-4" />
            {killSwitchPending ? t("connectorPanel.signing.stopping") : t("connectorPanel.signing.killSwitch")}
          </Button>
          {settings?.signing.enabled === false ? (
            <span className="text-xs text-destructive" data-testid="connector-panel-signing-off">
              {t("connectorPanel.signing.off")}
            </span>
          ) : null}
        </div>
      </div>

      {/* Journal */}
      <div className="space-y-2" data-testid="connector-panel-journal">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t("connectorPanel.journal.title")}
        </h3>
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <Label htmlFor="connector-journal-device">{t("connectorPanel.journal.device")}</Label>
            <select
              id="connector-journal-device"
              className={SELECT_CLASS}
              data-testid="connector-journal-device"
              value={journalDevice}
              onChange={(event) => setJournalDevice(event.target.value)}
            >
              <option value="">{t("connectorPanel.journal.allDevices")}</option>
              {[...journalDevices].map(([deviceId, name]) => (
                <option key={deviceId} value={deviceId}>{name}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="connector-journal-method">{t("connectorPanel.journal.method")}</Label>
            <select
              id="connector-journal-method"
              className={SELECT_CLASS}
              data-testid="connector-journal-method"
              value={journalMethod}
              onChange={(event) => setJournalMethod(event.target.value)}
            >
              <option value="">{t("connectorPanel.journal.allMethods")}</option>
              {JOURNAL_METHODS.map((method) => (
                <option key={method} value={method}>{method}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="connector-journal-outcome">{t("connectorPanel.journal.outcome")}</Label>
            <select
              id="connector-journal-outcome"
              className={SELECT_CLASS}
              data-testid="connector-journal-outcome"
              value={journalOutcome}
              onChange={(event) => setJournalOutcome(event.target.value)}
            >
              <option value="">{t("connectorPanel.journal.allOutcomes")}</option>
              {JOURNAL_OUTCOMES.map((outcome) => (
                <option key={outcome} value={outcome}>{outcome}</option>
              ))}
            </select>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={journalSignaturesOnly}
              onChange={(event) => setJournalSignaturesOnly(event.target.checked)}
            />
            {t("connectorPanel.journal.signaturesOnly")}
          </label>
        </div>
        {journalRows && journalRows.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="connector-panel-journal-table">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="py-1 pr-4">{t("connectorPanel.journal.when")}</th>
                  <th className="py-1 pr-4">{t("connectorPanel.journal.what")}</th>
                  <th className="py-1 pr-4">{t("connectorPanel.journal.device")}</th>
                  <th className="py-1 pr-4">{t("connectorPanel.journal.outcome")}</th>
                  <th className="py-1 pr-4">{t("connectorPanel.journal.confirmation")}</th>
                  <th className="py-1 pr-4">{t("connectorPanel.journal.documentHash")}</th>
                </tr>
              </thead>
              <tbody>
                {journalRows.map((row) => (
                  <tr key={row.id} className="border-b last:border-0">
                    <td className="py-1.5 pr-4 whitespace-nowrap text-muted-foreground">
                      {new Date(row.createdAt).toLocaleString()}
                    </td>
                    <td className="py-1.5 pr-4">
                      {row.method ?? row.action}
                      {row.url ? <div className="max-w-64 truncate text-xs text-muted-foreground">{row.url}</div> : null}
                      {row.signActionType ? (
                        <div className="text-xs text-muted-foreground" data-testid="connector-journal-sign-type">
                          {row.signActionType}
                        </div>
                      ) : null}
                    </td>
                    <td className="py-1.5 pr-4">
                      {row.deviceId ? journalDevices.get(row.deviceId) ?? row.deviceId : "—"}
                    </td>
                    <td className="py-1.5 pr-4">
                      <span className={row.outcome === "ok" ? "" : "text-destructive"}>{row.outcome ?? row.action}</span>
                    </td>
                    <td className="py-1.5 pr-4 text-muted-foreground">{row.confirmation ?? "—"}</td>
                    <td className="py-1.5 pr-4 font-mono text-xs" data-testid="connector-journal-doc-hash">
                      {row.documentHash ? `${row.documentHash.slice(0, 16)}…` : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground" data-testid="connector-panel-journal-empty">
            {journalLoading ? t("connectorPanel.journal.loading") : t("connectorPanel.journal.empty")}
          </p>
        )}
      </div>
    </section>
  );
}

/**
 * The container: wires the view to the queries and mutations. Kept next to the
 * view so the file pair stays one unit — the view is what the test renders.
 *
 * The journal query is derived from the view's filter state, which the view
 * owns; the container reads it back through a `journalQuery` callback so the
 * filters stay local and the query key still tracks them.
 */
export function ConnectorPanel({ journalQuery }: { journalQuery?: BridgeJournalQuery } = {}) {
  const queryClient = useQueryClient();
  const { selectedCompanyId } = useCompany();
  const [error, setError] = useState<string | null>(null);
  const [lastPairingCode, setLastPairingCode] = useState<{ code: string; expiresAt: string } | null>(null);

  const companyId = selectedCompanyId;
  const devicesQuery = useQuery({
    queryKey: companyId ? bridgeDevicesQueryKey(companyId) : ["myrmidon", "browser-bridge", "devices", "none"],
    queryFn: () => bridgeApi.listDevices(companyId!),
    enabled: companyId !== null,
    retry: false,
  });
  const settingsQuery = useQuery({
    queryKey: bridgeSettingsQueryKey,
    queryFn: () => bridgeApi.getSettings(),
    retry: false,
  });
  const journal = useQuery({
    queryKey: companyId ? bridgeJournalQueryKey(companyId, journalQuery ?? {}) : ["myrmidon", "browser-bridge", "journal", "none"],
    queryFn: () => bridgeApi.journal(companyId!, journalQuery ?? {}),
    enabled: companyId !== null,
    retry: false,
  });

  const pairing = useMutation({
    mutationFn: (label?: string) => bridgeApi.createPairingCode(companyId!, label),
    onMutate: () => setError(null),
    onError: (err) => setError(err instanceof Error ? err.message : "Issuing a pairing code failed."),
    onSuccess: (result) => {
      setError(null);
      setLastPairingCode({ code: result.code, expiresAt: result.expiresAt });
      void queryClient.invalidateQueries({ queryKey: ["myrmidon", "browser-bridge"] });
    },
  });
  const revoke = useMutation({
    mutationFn: (deviceId: string) => bridgeApi.revokeDevice(companyId!, deviceId),
    onMutate: () => setError(null),
    onError: (err) => setError(err instanceof Error ? err.message : "Revoking the device failed."),
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ["myrmidon", "browser-bridge"] });
    },
  });
  const save = useMutation({
    mutationFn: (patch: { domains: string[]; signing: BridgeSettings["signing"] }) => bridgeApi.updateSettings(patch),
    onMutate: () => setError(null),
    onError: (err) => setError(err instanceof Error ? err.message : "Saving the connector settings failed."),
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: bridgeSettingsQueryKey });
    },
  });
  const killSwitch = useMutation({
    mutationFn: () => bridgeApi.disableSigning(),
    onMutate: () => setError(null),
    onError: (err) => setError(err instanceof Error ? err.message : "The emergency stop failed."),
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: bridgeSettingsQueryKey });
    },
  });

  const queryError = devicesQuery.error ?? settingsQuery.error;
  if (queryError) {
    return (
      <div className="text-sm text-destructive" data-testid="connector-panel-error">
        {queryError instanceof Error ? queryError.message : "Failed to load the connector panel."}
      </div>
    );
  }

  return (
    <ConnectorPanelView
      devices={devicesQuery.data?.devices}
      settings={settingsQuery.data}
      journalRows={journal.data?.rows}
      signedToday={journal.data?.signedToday ?? null}
      journalLoading={journal.isPending}
      pairingPending={pairing.isPending}
      savePending={save.isPending}
      killSwitchPending={killSwitch.isPending}
      revokePending={revoke.isPending && revoke.variables !== undefined ? revoke.variables : null}
      lastPairingCode={lastPairingCode}
      error={error}
      onIssuePairing={(label) => pairing.mutate(label)}
      onRevokeDevice={(deviceId) => revoke.mutate(deviceId)}
      onSaveSettings={(patch) => save.mutate(patch)}
      onKillSwitch={() => killSwitch.mutate()}
    />
  );
}
