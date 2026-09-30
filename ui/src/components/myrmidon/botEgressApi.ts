// myrmidon(EGRESS-B): the API client behind the egress lists.
//
// The board edits the lists; the proxy reads the document the server publishes
// from them. Everything here is company-scoped, like the rest of the board's
// API surface.

import { api } from "../../api/client";
import type { EgressProjectMode } from "./botEgressConfig";

export interface ProjectEgressView {
  projectId: string;
  name: string;
  mode: EgressProjectMode;
  /** What the proxy would do: `block` only with a verified, non-empty list. */
  effectiveMode: EgressProjectMode;
  verified: boolean;
  allow: string[];
}

export interface BotEgressView {
  botKey: string;
  project: string;
  allow: string[];
}

export interface BotEgressPolicies {
  projects: ProjectEgressView[];
  bots: BotEgressView[];
}

export interface EgressRefusal {
  ts?: string;
  bot?: string;
  project?: string;
  method?: string;
  scheme?: string;
  destination?: string;
  port?: number;
  result?: string;
}

export interface ProjectEgressInput {
  mode: EgressProjectMode;
  verified: boolean;
  allow: string[];
}

export interface BotEgressInput {
  project: string;
  allow: string[];
}

function companyPath(companyId: string, suffix: string): string {
  return `/myrmidon/companies/${encodeURIComponent(companyId)}/bot-egress${suffix}`;
}

export const botEgressApi = {
  list: (companyId: string) => api.get<BotEgressPolicies>(companyPath(companyId, "/policies")),
  saveProject: (companyId: string, projectId: string, input: ProjectEgressInput) =>
    api.put<{ project: ProjectEgressView }>(companyPath(companyId, `/projects/${encodeURIComponent(projectId)}`), input),
  saveBot: (companyId: string, botKey: string, input: BotEgressInput) =>
    api.put<{ bot: BotEgressView }>(companyPath(companyId, `/bots/${encodeURIComponent(botKey)}`), input),
  refusals: (companyId: string) => api.get<{ refusals: EgressRefusal[] }>(companyPath(companyId, "/refusals")),
};