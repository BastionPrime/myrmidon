// server/src/myrmidon/wiki-cortex/render.ts
//
// myrmidon(1.6-WIKI): the delivered form of the approved regulations.
//
// The same input must always render byte-for-byte the same text: the container
// profile's hash is what decides whether a bot restarts, so a renderer that
// reorders or adds a timestamp would restart the whole fleet on every tick.

import type { ApprovedRegulation } from "./types.js";

/** Workspace file the approved regulations are delivered in. */
export const REGULATIONS_WORKSPACE_FILE = "REGULATIONS.md";

export function renderRegulationsMarkdown(regulations: readonly ApprovedRegulation[]): string {
  const lines: string[] = [
    "# Company regulations (approved)",
    "",
    "The company keeps its regulations in the wiki. The texts below are the approved revisions",
    "that apply to your role; they are the current rules of the company, not a suggestion.",
    "A draft or an edit that is not approved yet is not delivered here — treat the text below as",
    "the rules in force.",
    "",
  ];
  for (const regulation of regulations) {
    lines.push(`## ${regulation.title}`, "");
    lines.push(`Page: ${regulation.slug} · revision ${regulation.version}`, "");
    lines.push(regulation.content.trim(), "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}