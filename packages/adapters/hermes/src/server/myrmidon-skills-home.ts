import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// myrmidon(H1): install Paperclip-managed skills into the agent's own Hermes
// profile. Hermes isolates a profile through HERMES_HOME and keeps HOME shared,
// so agents sharing HOME must not share (and prune) one skills directory.

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function configEnv(config: Record<string, unknown>): Record<string, unknown> {
  return typeof config.env === "object" && config.env !== null && !Array.isArray(config.env)
    ? (config.env as Record<string, unknown>)
    : {};
}

/** Profile subdirectory that keeps skill copies moved aside by the adapter. */
export const SKILL_BACKUP_DIR = "skills.pre-myrmidon";

export interface HermesSkillsHome {
  /** Absolute directory Hermes reads skills from for this agent. */
  skillsHome: string;
  /** Path shown to operators, relative to the profile root. */
  locationLabel: string;
  /** True when the agent has its own HERMES_HOME profile. */
  profileScoped: boolean;
  /**
   * Where a profile's own copy of a managed skill is moved. It sits outside the
   * skills directory: Hermes discovers every SKILL.md below it by frontmatter
   * name, so a backup left there would collide with the managed skill.
   */
  backupRoot: string | null;
}

/**
 * `<HERMES_HOME>/skills` when the agent configures HERMES_HOME, otherwise the
 * vendor default `<HOME>/.hermes/skills`.
 */
export function resolveHermesSkillsHome(config: Record<string, unknown>): HermesSkillsHome {
  const env = configEnv(config);
  const configuredHome = asString(env.HOME);
  const home = configuredHome ? path.resolve(configuredHome) : os.homedir();
  const hermesHome = asString(env.HERMES_HOME);
  if (!hermesHome) {
    return {
      skillsHome: path.join(home, ".hermes", "skills"),
      locationLabel: "~/.hermes/skills",
      profileScoped: false,
      backupRoot: null,
    };
  }
  const expanded =
    hermesHome === "~"
      ? home
      : hermesHome.startsWith("~/")
        ? path.join(home, hermesHome.slice(2))
        : hermesHome;
  const profileRoot = path.resolve(expanded);
  return {
    skillsHome: path.join(profileRoot, "skills"),
    locationLabel: "$HERMES_HOME/skills",
    profileScoped: true,
    backupRoot: path.join(profileRoot, SKILL_BACKUP_DIR),
  };
}

function backupStamp(now: Date): string {
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
}

/**
 * Moves a real directory or file that occupies a managed skill's link target to
 * `<backupRoot>/<name>.pre-myrmidon-<YYYYMMDD>` (with a numeric suffix when that
 * name is taken) so the managed link can be created. Nothing is ever deleted.
 * Returns the backup's base name, or null when the target is absent or a
 * symlink.
 */
export async function moveOccupiedSkillTargetAside(
  target: string,
  backupRoot: string,
  now: Date = new Date(),
): Promise<string | null> {
  const existing = await fs.lstat(target).catch(() => null);
  if (!existing || existing.isSymbolicLink()) return null;
  await fs.mkdir(backupRoot, { recursive: true });
  const base = `${path.basename(target)}.pre-myrmidon-${backupStamp(now)}`;
  for (let attempt = 1; attempt <= 100; attempt += 1) {
    const name = attempt === 1 ? base : `${base}-${attempt}`;
    const destination = path.join(backupRoot, name);
    if (await fs.lstat(destination).catch(() => null)) continue;
    await fs.rename(target, destination);
    return name;
  }
  throw new Error(`Cannot move the existing "${path.basename(target)}" skill aside: too many backups.`);
}
