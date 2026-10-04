import { describe, expect, it } from "vitest";
import { AGENT_ROLE_LABELS } from "@paperclipai/shared";
import { DEFAULT_AGENT_NAME, nextAgentNameForRole } from "./onboarding-agent-role";

describe("nextAgentNameForRole", () => {
  it("fills the name from the role when the field is empty", () => {
    expect(nextAgentNameForRole({ currentName: "", nextRole: "cto" })).toBe(
      AGENT_ROLE_LABELS.cto,
    );
  });

  it("replaces the default name the wizard supplied", () => {
    expect(nextAgentNameForRole({ currentName: DEFAULT_AGENT_NAME, nextRole: "designer" })).toBe(
      AGENT_ROLE_LABELS.designer,
    );
  });

  it("replaces a label left by a previous role", () => {
    // Picking CTO then CMO should leave "CMO", not "CTO".
    expect(nextAgentNameForRole({ currentName: AGENT_ROLE_LABELS.cto, nextRole: "cmo" })).toBe(
      AGENT_ROLE_LABELS.cmo,
    );
  });

  it("keeps a name the customer typed", () => {
    // The failure this prevents is silent: the field still holds a plausible
    // name afterwards, so the loss is invisible until the agent is hired.
    expect(nextAgentNameForRole({ currentName: "Ada", nextRole: "engineer" })).toBe("Ada");
  });

  it("keeps a typed name that only differs by surrounding space", () => {
    expect(nextAgentNameForRole({ currentName: "  Ada  ", nextRole: "engineer" })).toBe("  Ada  ");
  });

  it("treats a whitespace-only field as empty", () => {
    expect(nextAgentNameForRole({ currentName: "   ", nextRole: "qa" })).toBe(AGENT_ROLE_LABELS.qa);
  });
});

// myrmidon(CUSTOM-CASTES): the label lookup accepts the caste directory's
// labels; the built-ins remain the fallback for a role the directory lacks.
describe("nextAgentNameForRole with caste directory labels", () => {
  it("fills the name from the directory label when the field is empty", () => {
    expect(
      nextAgentNameForRole({
        currentName: "",
        nextRole: "general",
        labels: { general: "Начальник штаба" },
      }),
    ).toBe("Начальник штаба");
  });

  it("replaces a name the directory itself supplied", () => {
    expect(
      nextAgentNameForRole({
        currentName: "Начальник штаба",
        nextRole: "engineer",
        labels: { general: "Начальник штаба", engineer: "Инженер" },
      }),
    ).toBe("Инженер");
  });

  it("falls back to the built-in label for a role the directory lacks", () => {
    expect(
      nextAgentNameForRole({ currentName: "", nextRole: "qa", labels: {} }),
    ).toBe(AGENT_ROLE_LABELS.qa);
  });

  it("keeps a name the customer typed, whatever the directory says", () => {
    expect(
      nextAgentNameForRole({
        currentName: "Ada",
        nextRole: "general",
        labels: { general: "Начальник штаба" },
      }),
    ).toBe("Ada");
  });
});
