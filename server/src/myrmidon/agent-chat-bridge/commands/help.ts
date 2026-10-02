// myrmidon(X8c): /help, /start, /commands.
// myrmidon(X8-texts): the bridged Telegram DM answers in Russian.

import type { BridgedCommandSpec } from "./index.js";

export function buildHelpText(
  agentName: string,
  commands: readonly BridgedCommandSpec[],
): string {
  const lines = [
    `Здесь вы общаетесь с ${agentName}. Задачи из этого чата создаются по необходимости.`,
    "",
  ];
  for (const command of commands) {
    lines.push(`/${command.command} — ${command.description}`);
  }
  lines.push("");
  lines.push("/model и /think действуют только на этот чат в Telegram.");
  return lines.join("\n");
}
