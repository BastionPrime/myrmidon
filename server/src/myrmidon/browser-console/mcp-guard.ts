// myrmidon(BROWSER-CONSOLE): the server-side MCP guard (bot pause, contour 2).
//
// While an owner screen session is open on a browser, the board must not let
// bot MCP clients drive that browser. The tool gateway consults this module
// at its browser-tool call points via assertBrowserConsoleMcpAllowed(). The
// guard is registered by the wiring (wiring.ts) so tests can install their
// own fake service.

import type { BrowserConsoleService } from "./service.js";

let guardService: BrowserConsoleService | null = null;

export function registerBrowserConsoleMcpGuard(service: BrowserConsoleService | null): void {
  guardService = service;
}

/**
 * Throw when a screen session is open on the browser a tool call targets.
 * The input names the browser the way the caller knows it; unknown ids are
 * free (the registry is env-configured and may lag a caller).
 */
export async function assertBrowserConsoleMcpAllowed(browserId: string): Promise<void> {
  const service = guardService;
  if (!service) return;
  await service.assertBrowserScreenFreeForMcp(browserId);
}
