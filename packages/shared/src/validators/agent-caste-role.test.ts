// packages/shared/src/validators/agent-caste-role.test.ts
//
// myrmidon(1.6.1 CUSTOM-CASTES B): the role field of the agent validators is
// a caste key, not the fixed 12-role enum. The format contract: latin letters,
// digits, hyphens, 1–60, trimmed; the *existence* of the key in a company's
// directory is a server-side check and stays out of the shared layer.

import { describe, expect, it } from "vitest";
import { createAgentSchema, updateAgentSchema } from "./agent.js";

const base = { name: "agent-a", adapterType: "process" as const };

describe("agent role is a caste key (format only)", () => {
  it("accepts built-in role keys", () => {
    for (const role of ["general", "engineer", "ceo", "security"]) {
      expect(createAgentSchema.parse({ ...base, role }).role).toBe(role);
    }
  });

  it("accepts custom caste keys", () => {
    expect(createAgentSchema.parse({ ...base, role: "reviewer" }).role).toBe("reviewer");
    expect(createAgentSchema.parse({ ...base, role: "focused-qa" }).role).toBe("focused-qa");
    expect(createAgentSchema.parse({ ...base, role: "sre-2" }).role).toBe("sre-2");
  });

  it("trims surrounding whitespace", () => {
    expect(createAgentSchema.parse({ ...base, role: "  reviewer " }).role).toBe("reviewer");
  });

  it("defaults to general when absent", () => {
    expect(createAgentSchema.parse(base).role).toBe("general");
  });

  it("refuses malformed keys and over-length keys", () => {
    for (const bad of ["", "   ", "has space", "under_score", "dot.role", "кириллица", "a".repeat(61)]) {
      expect(() => createAgentSchema.parse({ ...base, role: bad })).toThrow();
    }
  });

  it("the update schema keeps the same format rule and stays a pure patch", () => {
    expect(updateAgentSchema.parse({ role: "reviewer" }).role).toBe("reviewer");
    expect(updateAgentSchema.parse({}).role).toBeUndefined();
    expect(() => updateAgentSchema.parse({ role: "not a key" })).toThrow();
    expect(() => updateAgentSchema.parse({ role: "a".repeat(61) })).toThrow();
  });
});
