// myrmidon(BROWSER-CONSOLE): module entry point.
//
// Part A (this PR): the registry, the API, the session timers, the journal,
// the site-data clear and both contours of the bot pause. The screen node
// itself (x11vnc + websockify) and the WebSocket proxy route are part B.

export { browserConsoleService, BrowserConsoleError, type BrowserConsoleService } from "./service.js";
export { browserConsoleRoutes } from "./routes.js";
export { myrmidonBrowserConsoleRoutes, getBrowserConsoleService } from "./wiring.js";
export { registerBrowserConsoleMcpGuard, assertBrowserConsoleMcpAllowed } from "./mcp-guard.js";
export {
  readBrowserConsoleTimers,
  sessionDeadlines,
  autoCloseReason,
  AUTO_CLOSE_WARN_MS,
  DEFAULT_IDLE_TIMEOUT_MIN,
  DEFAULT_MAX_DURATION_MIN,
  BROWSER_IDLE_TIMEOUT_MIN_ENV,
  BROWSER_MAX_DURATION_MIN_ENV,
  type BrowserConsoleTimers,
} from "./timers.js";
export {
  readScreenConsoleSettings,
  screenConsoleClient,
  ScreenConsoleError,
  BROWSER_CONSOLE_HOST_ENV,
  BROWSER_CONSOLE_TOKEN_ENV,
  type ScreenConsoleClient,
} from "./screen-console-client.js";
export {
  readBrowserSessionDocument,
  mutateBrowserSessionDocument,
  parseBrowserSessionDocument,
  BROWSER_SESSIONS_GENERAL_KEY,
  BROWSER_JOURNAL_LIMIT,
} from "./store.js";
