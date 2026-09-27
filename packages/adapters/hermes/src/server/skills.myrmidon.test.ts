import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Spawn nothing: the run only has to get past skill reconciliation.
vi.mock("@paperclipai/adapter-utils/server-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/server-utils")>();
  return {
    ...actual,
    runChildProcess: vi.fn(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "",
    })),
  };
});

import * as serverUtils from "@paperclipai/adapter-utils/server-utils";
import { execute } from "./execute.js";
import { listHermesSkills, reconcileHermesPaperclipSkills } from "./skills.js";

// myrmidon(H1): Paperclip-managed skills belong in the agent's own Hermes
// profile (<HERMES_HOME>/skills), and one agent's run never prunes another's.

let root: string;
let sharedHome: string;
let profileA: string;
let profileB: string;
let runtimeSkills: Array<{ key: string; runtimeName: string; source: string }>;

async function writeSkill(dir: string, name: string, description = name) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n`,
    "utf8",
  );
}

function agentConfig(hermesHome: string | null, desiredSkills: string[]) {
  return {
    env: hermesHome ? { HOME: sharedHome, HERMES_HOME: hermesHome } : { HOME: sharedHome },
    paperclipRuntimeSkills: runtimeSkills,
    paperclipSkillSync: { desiredSkills },
  };
}

async function linkNames(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort();
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "myrmidon-hermes-skills-"));
  sharedHome = path.join(root, "home");
  profileA = path.join(sharedHome, ".hermes", "profiles", "agent-a");
  profileB = path.join(sharedHome, ".hermes", "profiles", "agent-b");
  await fs.mkdir(sharedHome, { recursive: true });
  runtimeSkills = [];
  for (const name of ["paperclip", "skill-a", "skill-b"]) {
    const source = path.join(root, "runtime-skills", name);
    await writeSkill(source, name, `managed ${name}`);
    // The operational "paperclip" skill is always required; the rest are optional.
    const key = name === "paperclip" ? "paperclipai/paperclip/paperclip" : `company-a/${name}`;
    runtimeSkills.push({ key, runtimeName: name, source });
  }
});

afterEach(async () => {
  vi.clearAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

describe("Hermes skills in per-agent profiles", () => {
  it("installs each agent's skills into its own HERMES_HOME profile", async () => {
    await reconcileHermesPaperclipSkills(agentConfig(profileA, ["company-a/skill-a"]));
    await reconcileHermesPaperclipSkills(agentConfig(profileB, ["company-a/skill-b"]));

    expect(await linkNames(path.join(profileA, "skills"))).toEqual(["paperclip", "skill-a"]);
    expect(await linkNames(path.join(profileB, "skills"))).toEqual(["paperclip", "skill-b"]);
    expect(await linkNames(path.join(sharedHome, ".hermes", "skills"))).toEqual([]);
  });

  it("does not remove another agent's links when one agent runs again", async () => {
    await reconcileHermesPaperclipSkills(agentConfig(profileA, ["company-a/skill-a"]));
    await reconcileHermesPaperclipSkills(agentConfig(profileB, ["company-a/skill-b"]));
    await reconcileHermesPaperclipSkills(agentConfig(profileA, ["company-a/skill-a"]));

    expect(await linkNames(path.join(profileB, "skills"))).toEqual(["paperclip", "skill-b"]);
    expect(await fs.realpath(path.join(profileB, "skills", "skill-b"))).toBe(
      await fs.realpath(runtimeSkills[2]!.source),
    );
  });

  it("still prunes this agent's own managed links that are no longer desired", async () => {
    await reconcileHermesPaperclipSkills(agentConfig(profileA, ["company-a/skill-a"]));
    await reconcileHermesPaperclipSkills(agentConfig(profileA, []));

    expect(await linkNames(path.join(profileA, "skills"))).toEqual(["paperclip"]);
  });

  it("lists skills from the agent's profile", async () => {
    await writeSkill(path.join(profileA, "skills", "research", "notes"), "notes");
    await writeSkill(path.join(sharedHome, ".hermes", "skills", "research", "other"), "other");

    const snapshot = await listHermesSkills({
      adapterType: "hermes_local",
      agentId: "agent-a",
      companyId: "company-a",
      config: agentConfig(profileA, []),
    });
    const keys = snapshot.entries.filter((entry) => !entry.managed).map((entry) => entry.key);
    expect(keys).toContain("notes");
    expect(keys).not.toContain("other");
    expect(snapshot.entries.find((entry) => entry.key === "notes")?.locationLabel).toBe(
      "$HERMES_HOME/skills/research/notes",
    );
  });

  it("keeps vendor behavior without HERMES_HOME", async () => {
    await reconcileHermesPaperclipSkills(agentConfig(null, ["company-a/skill-a"]));

    expect(await linkNames(path.join(sharedHome, ".hermes", "skills"))).toEqual([
      "paperclip",
      "skill-a",
    ]);
  });
});

describe("a real directory where a managed skill belongs", () => {
  it("moves the profile's copy aside, links the managed skill and starts the run", async () => {
    const occupied = path.join(profileA, "skills", "paperclip");
    await writeSkill(occupied, "paperclip", "local copy");
    await fs.writeFile(path.join(occupied, "notes.txt"), "keep me\n", "utf8");
    const onLog = vi.fn(async () => undefined);

    await execute({
      runId: "run-1",
      agent: {
        id: "agent-a",
        companyId: "company-a",
        name: "agent-a",
        adapterType: "hermes_local",
        adapterConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        command: path.join(root, "bin", "hermes"),
        timeoutSec: 60,
        graceSec: 5,
        ...agentConfig(profileA, []),
      },
      context: { issueId: "issue-1", wakeReason: "manual", paperclipWake: null },
      onLog,
      onMeta: vi.fn(async () => undefined),
      onSpawn: vi.fn(async () => undefined),
    } as never);

    expect(serverUtils.runChildProcess).toHaveBeenCalledTimes(1);
    expect((await fs.lstat(occupied)).isSymbolicLink()).toBe(true);
    expect(await fs.realpath(occupied)).toBe(await fs.realpath(runtimeSkills[0]!.source));

    const backups = await fs.readdir(path.join(profileA, "skills.pre-myrmidon"));
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatch(/^paperclip\.pre-myrmidon-\d{8}$/);
    const backup = path.join(profileA, "skills.pre-myrmidon", backups[0]!);
    expect(await fs.readFile(path.join(backup, "notes.txt"), "utf8")).toBe("keep me\n");
    // Hermes finds skills by SKILL.md anywhere under skills/, so the backup must
    // not stay there as a second "paperclip" skill.
    expect(await fs.readdir(path.join(profileA, "skills"))).toEqual(["paperclip"]);

    const lines = onLog.mock.calls
      .map((call) => String((call as unknown[])[1]))
      .filter((line) => line.includes("pre-myrmidon"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain(root);
  });

  it("keeps an earlier backup and never overwrites it", async () => {
    const occupied = path.join(profileA, "skills", "paperclip");
    await writeSkill(occupied, "paperclip", "first copy");
    await reconcileHermesPaperclipSkills(agentConfig(profileA, []));
    await fs.unlink(occupied);
    await writeSkill(occupied, "paperclip", "second copy");
    await reconcileHermesPaperclipSkills(agentConfig(profileA, []));

    const backups = (await fs.readdir(path.join(profileA, "skills.pre-myrmidon"))).sort();
    expect(backups).toHaveLength(2);
    const descriptions = await Promise.all(
      backups.map((name) =>
        fs.readFile(path.join(profileA, "skills.pre-myrmidon", name, "SKILL.md"), "utf8"),
      ),
    );
    expect(descriptions.join("\n")).toContain("first copy");
    expect(descriptions.join("\n")).toContain("second copy");
  });

  it("still refuses a live symlink owned by another installation", async () => {
    const foreign = path.join(root, "external-skills", "paperclip");
    await writeSkill(foreign, "paperclip", "foreign");
    await fs.mkdir(path.join(profileA, "skills"), { recursive: true });
    await fs.symlink(foreign, path.join(profileA, "skills", "paperclip"));

    await expect(
      reconcileHermesPaperclipSkills(agentConfig(profileA, [])),
    ).rejects.toThrow("occupied by another installation");
    expect(await fs.realpath(path.join(profileA, "skills", "paperclip"))).toBe(
      await fs.realpath(foreign),
    );
  });
});
