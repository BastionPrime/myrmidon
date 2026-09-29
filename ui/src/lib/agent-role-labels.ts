// myrmidon(UI-RU): localized agent role labels. Falls back to the raw role
// code when the role is unknown, same as the vendor map fallback.
import type { TFunction } from "i18next";

const AGENT_ROLE_KEYS: Record<string, string> = {
  ceo: "agentRoles.ceo",
  cto: "agentRoles.cto",
  cmo: "agentRoles.cmo",
  cfo: "agentRoles.cfo",
  security: "agentRoles.security",
  engineer: "agentRoles.engineer",
  designer: "agentRoles.designer",
  pm: "agentRoles.pm",
  qa: "agentRoles.qa",
  devops: "agentRoles.devops",
  researcher: "agentRoles.researcher",
  general: "agentRoles.general",
};

export function localizedAgentRoleLabel(role: string, t: TFunction): string {
  const key = AGENT_ROLE_KEYS[role];
  return key ? t(key) : role;
}
