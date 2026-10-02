// Board self-deploy (myrmidon R5-A): settings (MYRMIDON_DEPLOY_*). See docs/myrmidon/SETTINGS.md.
//
// Everything deployment-specific is off or neutral by default: the registry
// and GitHub endpoints stay at their public values, and no board action is
// possible until MYRMIDON_DEPLOY_ENABLED=1 — an instance that never opted in
// answers "not enabled" instead of guessing a host layout.
//
// R5-C adds two switches read here: MYRMIDON_DEPLOY_AUTO_ROLLBACK (on by
// default — rolling a failed deploy back IS the feature) and
// MYRMIDON_DEPLOY_AUTO_UPDATE (off by default — unattended deploys wait for
// the staging stand, STAND).

function readInt(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) return fallback;
  return value;
}

function readBool(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return fallback;
}

export interface DeployJobsSettings {
  enabled: boolean;
  /** Digest verification: how long the registry/GitHub checks may take. */
  verifyTimeoutMs: number;
  /** How often the tick reconciles open jobs with maintenance and health. */
  tickMs: number;
  /** After this many ms in one non-terminal status the job is aborted. */
  stepTimeoutMs: number;
  /** Poll interval of the health check phase, ms. */
  healthPollMs: number;
  /** Health check phase budget, ms. */
  healthTimeoutMs: number;
  /** JSON object of GitHub API request headers, or null. */
  githubHeaders: Record<string, string> | null;
  /** Registry inspect base (a proxy), or null for the default ghcr.io. */
  registryInspectUrl: string | null;
  /**
   * R5-C: roll the board back to the locally remembered previous image when
   * the health check of a deploy fails. On by default: it is the feature's
   * own behavior (an automatic deploy must not leave the board stuck on a
   * broken image); MYRMIDON_DEPLOY_AUTO_ROLLBACK=0 restores the manual
   * "window stays open for the operator" contract.
   */
  autoRollback: boolean;
  /**
   * R5-C: allow deploys to start WITHOUT a per-deploy confirmation in the
   * interface. Off by default and stays off until the release scenario has
   * run on the staging stand (STAND): an unattended auto-update without a
   * stand is the risk the plan calls out.
   */
  autoUpdate: boolean;
}

function readHeaders(env: NodeJS.ProcessEnv, name: string): Record<string, string> | null {
  const raw = env[name]?.trim();
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== "string") return null;
      out[key] = value;
    }
    return Object.keys(out).length > 0 ? out : null;
  } catch {
    return null;
  }
}

export function readDeployJobsSettings(env: NodeJS.ProcessEnv = process.env): DeployJobsSettings {
  return {
    enabled: readBool(env, "MYRMIDON_DEPLOY_ENABLED", false),
    verifyTimeoutMs: readInt(env, "MYRMIDON_DEPLOY_VERIFY_TIMEOUT_SEC", 30, 1, 300) * 1000,
    tickMs: readInt(env, "MYRMIDON_DEPLOY_TICK_SEC", 5, 1, 3600) * 1000,
    stepTimeoutMs: readInt(env, "MYRMIDON_DEPLOY_STEP_TIMEOUT_SEC", 1800, 10, 86_400) * 1000,
    healthPollMs: readInt(env, "MYRMIDON_DEPLOY_HEALTH_POLL_SEC", 5, 1, 300) * 1000,
    healthTimeoutMs: readInt(env, "MYRMIDON_DEPLOY_HEALTH_TIMEOUT_SEC", 300, 10, 3600) * 1000,
    githubHeaders: readHeaders(env, "MYRMIDON_DEPLOY_GITHUB_HEADERS_JSON"),
    registryInspectUrl: env.MYRMIDON_DEPLOY_REGISTRY_INSPECT_URL?.trim() || null,
    autoRollback: readBool(env, "MYRMIDON_DEPLOY_AUTO_ROLLBACK", true),
    autoUpdate: readBool(env, "MYRMIDON_DEPLOY_AUTO_UPDATE", false),
  };
}
