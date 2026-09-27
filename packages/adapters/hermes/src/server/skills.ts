import fs from "node:fs/promises";
import path from "node:path";
import type {
  AdapterSkillContext,
  AdapterSkillEntry,
  AdapterSkillSnapshot,
} from "@paperclipai/adapter-utils";
import {
  ensurePaperclipSkillSymlink,
  isPaperclipSkillSourceMissing,
  readInstalledSkillTargets,
  readPaperclipRuntimeSkillEntries,
  resolveLegacyPaperclipDesiredSkillNames,
} from "@paperclipai/adapter-utils/server-utils";
import { fileURLToPath } from "node:url";
import {
  moveOccupiedSkillTargetAside,
  resolveHermesSkillsHome,
  SKILL_BACKUP_DIR,
} from "./myrmidon-skills-home.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface SkillFrontmatter {
  name?: string;
  description?: string;
  version?: string;
  category?: string;
  metadata?: Record<string, unknown>;
}

function parseSkillFrontmatter(content: string): SkillFrontmatter {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return {};
  const frontmatter: Record<string, unknown> = {};
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let val: unknown = line.slice(idx + 1).trim();
    // Strip quotes
    if (typeof val === "string" && ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))) {
      val = val.slice(1, -1);
    }
    frontmatter[key] = val;
  }
  return frontmatter as SkillFrontmatter;
}

async function scanHermesSkills(
  skillsHome: string,
  locationRoot = "~/.hermes/skills", // myrmidon(H1): label the profile skills directory
): Promise<AdapterSkillEntry[]> {
  const entries: AdapterSkillEntry[] = [];

  try {
    const categories = await fs.readdir(skillsHome, { withFileTypes: true });
    for (const cat of categories) {
      if (!cat.isDirectory()) continue;
      const catPath = path.join(skillsHome, cat.name);

      // Check if the category directory itself has a SKILL.md (top-level skill)
      const topLevelSkillMd = path.join(catPath, "SKILL.md");
      if (await fs.stat(topLevelSkillMd).catch(() => null)) {
        entries.push(await buildSkillEntry(cat.name, topLevelSkillMd, cat.name, locationRoot));
      }

      // Scan for sub-skills
      const items = await fs.readdir(catPath, { withFileTypes: true }).catch(() => []);
      for (const item of items) {
        if (!item.isDirectory()) continue;
        const skillMd = path.join(catPath, item.name, "SKILL.md");
        if (await fs.stat(skillMd).catch(() => null)) {
          const key = item.name;
          entries.push(await buildSkillEntry(key, skillMd, `${cat.name}/${item.name}`, locationRoot));
        }
      }
    }
  } catch {
    // ~/.hermes/skills/ doesn't exist — no skills available
  }

  return entries.sort((a, b) => a.key.localeCompare(b.key));
}

async function buildSkillEntry(
  key: string,
  skillMdPath: string,
  categoryPath: string,
  locationRoot = "~/.hermes/skills",
): Promise<AdapterSkillEntry> {
  let description: string | null = null;
  try {
    const content = await fs.readFile(skillMdPath, "utf8");
    const fm = parseSkillFrontmatter(content);
    description = fm.description ?? null;
  } catch {
    // ignore
  }

  return {
    key,
    runtimeName: key,
    desired: true, // Hermes loads all available skills
    managed: false,
    state: "installed",
    origin: "user_installed",
    originLabel: "Hermes skill",
    locationLabel: `${locationRoot}/${categoryPath}`,
    readOnly: true, // Hermes manages its own skills — Paperclip can't toggle them
    sourcePath: skillMdPath,
    targetPath: null,
    detail: description,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

async function buildHermesSkillSnapshot(config: Record<string, unknown>): Promise<AdapterSkillSnapshot> {
  // myrmidon(H1): list skills from the agent's own profile when HERMES_HOME is set
  const { skillsHome: hermesSkillsHome, locationLabel } = resolveHermesSkillsHome(config);

  // 1. Scan Paperclip-managed skills (bundled with the adapter)
  const paperclipEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredSkills = resolveLegacyPaperclipDesiredSkillNames(config, paperclipEntries);
  const desiredSet = new Set(desiredSkills);
  const availableByKey = new Map(paperclipEntries.map((e) => [e.key, e]));

  // 2. Scan Hermes's own skills from ~/.hermes/skills/
  const hermesSkillEntries = await scanHermesSkills(hermesSkillsHome, locationLabel);
  const hermesKeys = new Set(hermesSkillEntries.map((e) => e.key));

  // 3. Merge: Paperclip skills first (ephemeral), then Hermes skills
  const entries: AdapterSkillEntry[] = [];
  const warnings: string[] = [];

  // Paperclip-managed skills
  for (const entry of paperclipEntries) {
    const desired = desiredSet.has(entry.key);
    entries.push({
      key: entry.key,
      runtimeName: entry.runtimeName,
      desired,
      managed: true,
      state: desired ? "configured" : "available",
      origin: "company_managed",
      originLabel: "Managed by Paperclip",
      readOnly: false,
      sourcePath: entry.source,
      targetPath: null,
      detail: desired
        ? "Will be available on the next run via Hermes skill loading."
        : null,
    });
  }

  // Hermes-installed skills (read-only, always loaded)
  for (const entry of hermesSkillEntries) {
    // Skip if Paperclip already manages a skill with the same key
    if (availableByKey.has(entry.key)) continue;
    entries.push(entry);
  }

  // Check for desired skills that don't exist
  for (const desiredSkill of desiredSkills) {
    if (availableByKey.has(desiredSkill) || hermesKeys.has(desiredSkill)) continue;
    warnings.push(
      `Desired skill "${desiredSkill}" is not available in Paperclip or Hermes skills.`,
    );
    entries.push({
      key: desiredSkill,
      runtimeName: null,
      desired: true,
      managed: true,
      state: "missing",
      origin: "external_unknown",
      originLabel: "External or unavailable",
      readOnly: false,
      sourcePath: null,
      targetPath: null,
      detail:
        "Cannot find this skill in Paperclip or ~/.hermes/skills/.",
    });
  }

  return {
    adapterType: "hermes_local",
    supported: true,
    mode: "persistent",
    desiredSkills,
    entries,
    warnings,
  };
}

export async function listHermesSkills(
  ctx: AdapterSkillContext,
): Promise<AdapterSkillSnapshot> {
  return buildHermesSkillSnapshot(ctx.config);
}

export async function reconcileHermesPaperclipSkills(
  config: Record<string, unknown>,
  requestedDesiredSkills?: string[],
  // myrmidon(H1): run-log sink for moving a profile's own skill copy aside
  options: { onLog?: (line: string) => Promise<void> | void } = {},
): Promise<string[]> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredSkills = requestedDesiredSkills
    ? Array.from(new Set([
        ...resolveLegacyPaperclipDesiredSkillNames({}, availableEntries),
        ...requestedDesiredSkills,
      ]))
    : resolveLegacyPaperclipDesiredSkillNames(config, availableEntries);
  const desiredSet = new Set(desiredSkills);
  // myrmidon(H1): install into the agent's own profile when HERMES_HOME is set
  const { skillsHome, backupRoot } = resolveHermesSkillsHome(config);
  await fs.mkdir(skillsHome, { recursive: true });
  const installed = await readInstalledSkillTargets(skillsHome);
  const availableByRuntimeName = new Map(availableEntries.map((entry) => [entry.runtimeName, entry]));

  for (const entry of availableEntries) {
    if (!desiredSet.has(entry.key) || isPaperclipSkillSourceMissing(entry)) continue;
    const target = path.join(skillsHome, entry.runtimeName);
    // myrmidon(H1): a real directory in the profile is kept under a backup name, never deleted
    const movedAside = backupRoot ? await moveOccupiedSkillTargetAside(target, backupRoot) : null;
    if (movedAside) {
      await options.onLog?.(
        `[hermes] Moved the profile's own "${entry.runtimeName}" skill to ${SKILL_BACKUP_DIR}/${movedAside} and linked the managed skill.\n`,
      );
    }
    await ensurePaperclipSkillSymlink(entry.source, target);
    const linkedSource = await fs.readlink(target).catch(() => null);
    const resolvedSource = linkedSource
      ? path.resolve(path.dirname(target), linkedSource)
      : null;
    if (resolvedSource !== path.resolve(entry.source)) {
      throw new Error(
        `Cannot reconcile Hermes skill "${entry.key}" because ${target} is occupied by another installation.`,
      );
    }
  }

  for (const [name, installedEntry] of installed.entries()) {
    const available = availableByRuntimeName.get(name);
    if (!available || desiredSet.has(available.key)) continue;
    if (installedEntry.targetPath !== available.source) continue;
    await fs.unlink(path.join(skillsHome, name)).catch(() => {});
  }

  return desiredSkills;
}

export async function syncHermesSkills(
  ctx: AdapterSkillContext,
  desiredSkills: string[],
): Promise<AdapterSkillSnapshot> {
  await reconcileHermesPaperclipSkills(ctx.config, desiredSkills);
  return buildHermesSkillSnapshot(ctx.config);
}

export function resolveHermesDesiredSkillNames(
  config: Record<string, unknown>,
  availableEntries: Array<{ key: string; runtimeName?: string | null }>,
): string[] {
  return resolveLegacyPaperclipDesiredSkillNames(config, availableEntries);
}
