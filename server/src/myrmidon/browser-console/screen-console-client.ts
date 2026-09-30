// myrmidon(BROWSER-CONSOLE): the screen node contract.
//
// The real node (x11vnc + websockify over a live browser, part B) exposes a
// small HTTP API. The board module talks to it through this interface only,
// so tests run against a fake and the board never depends on node internals.
//
//   open(browserId) -> { wsUrl, screenSessionId }
//   done(screenSessionId)
//   heartbeat(screenSessionId, activity)
//   pauseBots(browserId) / resumeBots(browserId)
//   clearSiteData(browserId, domain)
//
// pauseBots/resumeBots is the CONTRACT contour of the bot pause: while an
// owner screen session is open, MCP clients of the bots must not drive the
// browser. The board adds its own server-side guard (browser-console-guard.ts)
// so the pause holds even if the node call is lost.

export interface ScreenConsoleOpenResult {
  /** WebSocket URL of the screen on the node (board proxies it). */
  wsUrl: string;
  /** Node-side session handle used by done()/heartbeat(). */
  screenSessionId: string;
}

export interface ScreenConsoleClient {
  open(browserId: string): Promise<ScreenConsoleOpenResult>;
  done(screenSessionId: string): Promise<void>;
  heartbeat(screenSessionId: string, activity: boolean): Promise<void>;
  pauseBots(browserId: string): Promise<void>;
  resumeBots(browserId: string): Promise<void>;
  /** Cookies + storage of one domain via CDP on the node. */
  clearSiteData(browserId: string, domain: string): Promise<void>;
}

export class ScreenConsoleError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** The HTTP client of the real node (part B). Kept here so the contract and
 *  the wire shape live in one file; used only by the wiring, never by tests. */
type Fetch = (input: string, init: RequestInit) => Promise<Response>;

export const BROWSER_CONSOLE_HOST_ENV = "MYRMIDON_BROWSER_CONSOLE_HOST";
export const BROWSER_CONSOLE_TOKEN_ENV = "MYRMIDON_BROWSER_CONSOLE_TOKEN";

export function readScreenConsoleSettings(
  env: NodeJS.ProcessEnv = process.env,
): { host: string; token: string } | null {
  const host = env[BROWSER_CONSOLE_HOST_ENV]?.trim().replace(/\/+$/, "");
  const token = env[BROWSER_CONSOLE_TOKEN_ENV]?.trim();
  if (!host || !token) return null;
  return { host, token };
}

export function screenConsoleClient(
  settings: { host: string; token: string },
  deps: { fetch?: Fetch; timeoutMs?: number } = {},
): ScreenConsoleClient {
  const doFetch = deps.fetch ?? ((input, init) => fetch(input, init));
  const timeoutMs = deps.timeoutMs ?? 10_000;

  async function call(path: string): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await doFetch(`${settings.host}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // The token is a header value, never logged.
          authorization: `Bearer ${settings.token}`,
        },
        body: "{}",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new ScreenConsoleError(502, `screen console request failed: ${err instanceof Error ? err.name : "error"}`);
    }
    if (!response.ok) {
      throw new ScreenConsoleError(response.status === 401 || response.status === 403 ? 502 : response.status, `screen console returned HTTP ${response.status}`);
    }
    return (await response.json().catch(() => ({}))) as Record<string, unknown>;
  }

  function arg(value: string): string {
    return encodeURIComponent(value);
  }

  return {
    async open(browserId) {
      const body = await call(`/browsers/${arg(browserId)}/open`);
      const wsUrl = typeof body.wsUrl === "string" ? body.wsUrl : null;
      const screenSessionId = typeof body.screenSessionId === "string" ? body.screenSessionId : null;
      if (!wsUrl || !screenSessionId) throw new ScreenConsoleError(502, "screen console open response is missing wsUrl or screenSessionId");
      return { wsUrl, screenSessionId };
    },
    async done(screenSessionId) {
      await call(`/sessions/${arg(screenSessionId)}/done`);
    },
    async heartbeat(screenSessionId, activity) {
      await call(`/sessions/${arg(screenSessionId)}/heartbeat?activity=${activity ? "1" : "0"}`);
    },
    async pauseBots(browserId) {
      await call(`/browsers/${arg(browserId)}/pause`);
    },
    async resumeBots(browserId) {
      await call(`/browsers/${arg(browserId)}/resume`);
    },
    async clearSiteData(browserId, domain) {
      await call(`/browsers/${arg(browserId)}/clear-site-data?domain=${arg(domain)}`);
    },
  };
}
