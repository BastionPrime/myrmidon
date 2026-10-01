// Server console (SC1): the panel section that opens an SSH terminal to a fleet
// node in the browser.
//
// The panel asks its own API for a short-lived, signed Guacamole auth-JSON (see
// docs/myrmidon/design/server-console.md) and hands the browser only that blob:
// the node password stays inside the ciphertext, and the blob stops working when
// its `expires` passes. Only a company owner reaches the API, so a member sees
// the request fail rather than a terminal.
//
// The terminal itself is the Guacamole client in a frame. No Guacamole SDK is
// shipped with the panel; the client reads the blob from the `data` query
// parameter of its own URL.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MonitorPlay } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCompany } from "@/context/CompanyContext";
import {
  describeServerTarget,
  fleetConsoleApi,
  fleetConsoleQueryKey,
  secondsUntil,
  type ConsoleToken,
  type FleetConsoleProtocol,
  type FleetServer,
  type FleetServerInput,
} from "./fleetConsoleApi";

const SELECT_CLASS = "h-9 w-full rounded-md border border-input bg-background px-2 text-sm";

export interface FleetConsolePanelViewProps {
  servers: FleetServer[] | undefined;
  activeToken: ConsoleToken | null;
  loading: boolean;
  pending: boolean;
  error: string | null;
  onOpenConsole: (server: FleetServer) => void;
  onCloseSession: () => void;
  onRegister: (input: FleetServerInput) => void;
  /** Injectable clock for the token deadline; the container uses the real one. */
  nowMs?: number;
}

export function FleetConsolePanelView({
  servers,
  activeToken,
  loading,
  pending,
  error,
  onOpenConsole,
  onCloseSession,
  onRegister,
  nowMs = Date.now(),
}: FleetConsolePanelViewProps) {
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [hostname, setHostname] = useState("");
  const [port, setPort] = useState("");
  const [protocol, setProtocol] = useState<FleetConsoleProtocol>("ssh");
  const [username, setUsername] = useState("");
  const [passwordSecretKey, setPasswordSecretKey] = useState("");

  const canRegister = !pending && slug.trim().length > 0 && name.trim().length > 0 && hostname.trim().length > 0;
  const parsedPort = port.trim() ? Number(port) : undefined;
  const portValid = parsedPort === undefined || (Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort < 65536);

  function submit() {
    if (!canRegister || !portValid) return;
    onRegister({
      slug: slug.trim(),
      name: name.trim(),
      hostname: hostname.trim(),
      ...(parsedPort === undefined ? {} : { port: parsedPort }),
      protocol,
      ...(username.trim() ? { username: username.trim() } : {}),
      ...(passwordSecretKey.trim() ? { passwordSecretKey: passwordSecretKey.trim() } : {}),
    });
    setSlug("");
    setName("");
    setHostname("");
    setPort("");
    setUsername("");
    setPasswordSecretKey("");
  }

  return (
    <section className="space-y-4" data-testid="myrmidon-fleet-console">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <MonitorPlay className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Server console</h2>
        </div>
        <p className="text-sm text-muted-foreground">
          Open a terminal to a fleet node in the browser. The panel signs a short-lived Guacamole token for the node;
          the node password stays on the server inside that token. Only a company owner can open a console.
        </p>
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      {activeToken ? (
        <div className="space-y-2 rounded-md border border-border px-3 py-3" data-testid="fleet-console-session">
          <div className="flex flex-col gap-1 md:flex-row md:items-center md:justify-between">
            <div className="min-w-0">
              <div className="text-sm font-medium">
                {activeToken.serverName} ({activeToken.protocol})
              </div>
              <div className="text-xs text-muted-foreground">
                Token expires in {secondsUntil(activeToken.expiresAt, nowMs)} s
              </div>
            </div>
            <div className="flex items-center gap-2">
              <a
                className="text-xs text-muted-foreground underline"
                href={activeToken.consoleUrl}
                target="_blank"
                rel="noreferrer"
                data-testid="fleet-console-new-tab"
              >
                Open in a new tab
              </a>
              <Button size="sm" variant="outline" onClick={onCloseSession} data-testid="fleet-console-close">
                Close session
              </Button>
            </div>
          </div>
          <iframe
            className="h-96 w-full rounded-md border border-border bg-background"
            src={activeToken.consoleUrl}
            title={`Console: ${activeToken.serverName}`}
            data-testid="fleet-console-terminal"
          />
        </div>
      ) : null}

      <div className="space-y-2">
        <div className="text-sm font-medium">Fleet servers</div>
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading the registry…</p>
        ) : servers && servers.length > 0 ? (
          <ul className="space-y-2">
            {servers.map((server) => (
              <li
                key={server.id}
                className="flex flex-col gap-2 rounded-md border border-border px-3 py-2 text-sm md:flex-row md:items-center md:justify-between"
                data-testid={`fleet-console-server-${server.slug}`}
              >
                <div className="min-w-0">
                  <div className="font-medium">
                    {server.name} <span className="text-muted-foreground">({server.slug})</span>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {server.protocol} · {describeServerTarget(server)} · {server.username}
                    {server.enabled ? "" : " · disabled"}
                  </div>
                </div>
                <Button
                  size="sm"
                  disabled={pending || !server.enabled}
                  onClick={() => onOpenConsole(server)}
                  data-testid={`fleet-console-open-${server.slug}`}
                >
                  Console
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground" data-testid="fleet-console-empty">
            No fleet servers are registered yet. Register the first node below.
          </p>
        )}
      </div>

      <div className="space-y-2 rounded-md border border-border px-3 py-3" data-testid="fleet-console-register">
        <div className="text-sm font-medium">Register a node</div>
        <div className="grid gap-2 md:grid-cols-3">
          <div className="space-y-1">
            <Label htmlFor="fleet-console-slug">Name key</Label>
            <Input
              id="fleet-console-slug"
              value={slug}
              onChange={(event) => setSlug(event.target.value)}
              placeholder="node-a"
              data-testid="fleet-console-register-slug"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="fleet-console-name">Display name</Label>
            <Input
              id="fleet-console-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Node A"
              data-testid="fleet-console-register-name"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="fleet-console-host">Host</Label>
            <Input
              id="fleet-console-host"
              value={hostname}
              onChange={(event) => setHostname(event.target.value)}
              placeholder="192.0.2.10"
              data-testid="fleet-console-register-host"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="fleet-console-port">Port</Label>
            <Input
              id="fleet-console-port"
              value={port}
              onChange={(event) => setPort(event.target.value)}
              placeholder="22"
              data-testid="fleet-console-register-port"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="fleet-console-protocol">Protocol</Label>
            <select
              id="fleet-console-protocol"
              className={SELECT_CLASS}
              value={protocol}
              onChange={(event) => setProtocol(event.target.value === "vnc" ? "vnc" : "ssh")}
              data-testid="fleet-console-register-protocol"
            >
              <option value="ssh">ssh</option>
              <option value="vnc">vnc</option>
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="fleet-console-username">Node user</Label>
            <Input
              id="fleet-console-username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="fleet-console"
              data-testid="fleet-console-register-username"
            />
          </div>
          <div className="space-y-1 md:col-span-2">
            <Label htmlFor="fleet-console-secret">Password secret key</Label>
            <Input
              id="fleet-console-secret"
              value={passwordSecretKey}
              onChange={(event) => setPasswordSecretKey(event.target.value)}
              placeholder="node-a-password"
              data-testid="fleet-console-register-secret"
            />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            disabled={!canRegister || !portValid}
            onClick={submit}
            data-testid="fleet-console-register-submit"
          >
            Register node
          </Button>
          {!portValid ? <span className="text-xs text-destructive">Port must be between 1 and 65535.</span> : null}
        </div>
      </div>
    </section>
  );
}

export function FleetConsolePanel() {
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();
  const companyId = selectedCompanyId ?? "";
  const queryKey = fleetConsoleQueryKey(companyId);
  const [activeToken, setActiveToken] = useState<ConsoleToken | null>(null);
  const [error, setError] = useState<string | null>(null);

  const serversQuery = useQuery({
    queryKey,
    queryFn: () => fleetConsoleApi.list(companyId),
    enabled: companyId.length > 0,
    retry: false,
  });

  const onError = (err: unknown) =>
    setError(err instanceof Error ? err.message : "The console request failed.");

  const tokenMutation = useMutation({
    mutationFn: (server: FleetServer) => fleetConsoleApi.requestToken(companyId, server),
    onMutate: () => setError(null),
    onSuccess: (token) => setActiveToken(token),
    onError,
  });

  const closeMutation = useMutation({
    mutationFn: (sessionId: string) => fleetConsoleApi.closeSession(companyId, sessionId),
    onSuccess: () => setActiveToken(null),
    onError,
  });

  const registerMutation = useMutation({
    mutationFn: (input: FleetServerInput) => fleetConsoleApi.register(companyId, input),
    onMutate: () => setError(null),
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
    onError,
  });

  function openConsole(server: FleetServer) {
    const previous = activeToken;
    setActiveToken(null);
    if (previous) void closeMutation.mutateAsync(previous.sessionId).catch(() => undefined);
    tokenMutation.mutate(server);
  }

  function closeSession() {
    if (activeToken) closeMutation.mutate(activeToken.sessionId);
  }

  return (
    <FleetConsolePanelView
      servers={serversQuery.data?.servers}
      activeToken={activeToken}
      loading={serversQuery.isLoading}
      pending={tokenMutation.isPending || closeMutation.isPending || registerMutation.isPending}
      error={error ?? (serversQuery.isError ? "The fleet registry could not be read." : null)}
      onOpenConsole={openConsole}
      onCloseSession={closeSession}
      onRegister={(input) => registerMutation.mutate(input)}
    />
  );
}