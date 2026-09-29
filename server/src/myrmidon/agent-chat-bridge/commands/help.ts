// myrmidon(X8c): /help, /start, /commands.

import type { BridgedCommandSpec } from "./index.js";

export function buildHelpText(
  agentName: string,
  commands: readonly BridgedCommandSpec[],
): string {
  const lines = [`Talk to ${agentName} here. Tasks are created from this chat when needed.`, ""];
  for (const command of commands) {
    lines.push(`/${command.command} — ${command.description}`);
  }
  lines.push("");
  lines.push("/model and /think apply to this Telegram chat only.");
  return lines.join("\n");
}
