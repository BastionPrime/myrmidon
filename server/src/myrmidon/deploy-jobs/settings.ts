// Board self-deploy (myrmidon R5-A): settings (MYRMIDON_DEPLOY_*). See docs/myrmidon/SETTINGS.md.
//
// Everything deployment-specific is off or neutral by default: the registry
// and GitHub endpoints stay at their public values, and no board action is
// possible until MYRMIDON_DEPLOY_ENABLED=1 — an instance that never opted in
// answers "not enabled" instead of guessing a host layout.

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
  };
}
