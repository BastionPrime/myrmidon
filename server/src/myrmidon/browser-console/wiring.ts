// myrmidon(BROWSER-CONSOLE): real wiring for app.ts.
//
// One process-wide service: routes, the MCP guard registration and (later,
// part B) the screen WebSocket proxy all share the same session state.

import type { Db } from "@paperclipai/db";
import { browserConsoleService, type BrowserConsoleService } from "./service.js";
import { readScreenConsoleSettings, screenConsoleClient } from "./screen-console-client.js";
import { browserConsoleRoutes } from "./routes.js";
import { registerBrowserConsoleMcpGuard } from "./mcp-guard.js";

let registered: BrowserConsoleService | null = null;

/** The service the MCP guard uses; null before the first wiring. */
export function getBrowserConsoleService(): BrowserConsoleService | null {
  return registered;
}

export function myrmidonBrowserConsoleRoutes(db: Db) {
  const service = browserConsoleService({
    db,
    client: screenConsoleClient(readScreenConsoleSettings() ?? { host: "http://localhost.invalid", token: "unset" }),
  });
  registered = service;
  registerBrowserConsoleMcpGuard(service);
  return browserConsoleRoutes({ service });
}
