/**
 * myrmidon(S2-hostcred): a run never inherits the host's GitHub credentials.
 *
 * Vendor behavior. When no managed GitHub identity is configured, the trust
 * preset is `standard`, and the run's environment driver is `local` or `ssh`,
 * the controller puts the run into "host" GitHub mode. It then reads the host
 * process environment — GH_TOKEN, GITHUB_TOKEN, GH_CONFIG_DIR, SSH_AUTH_SOCK,
 * GIT_ASKPASS, GIT_CONFIG_*, the host HOME — and copies those variables into
 * the run's environment, so a run of any host agent can act as the operator's
 * GitHub account. `packages/adapter-utils/src/execution-target.ts`
 * (`prepareGitHubExecutionEnvironment`, the `host` branch of its probe) is the
 * single place that performs that copy.
 *
 * Our behavior. That transfer is off. The run takes the managed side of the
 * same choice: the board mints a run-scoped GitHub capability token, stages
 * `git`/`gh` launchers next to the run, and the launchers resolve credentials
 * through the broker (`githubBrokerEnvironment` / `githubLauncherSource`
 * already blank the ambient credential names), which reads the store and
 * writes an access event. The host's own env still serves the controller's
 * own checkouts and fetches through `services/git-credentials.ts`; what closes
 * here is the direct inheritance of host credentials into the run environment.
 *
 * Full closure (every GitHub call resolving from the secret store under
 * per-agent permissions, S1-A / S6 in the update plan) waits for those items;
 * until they land the broker can still fall back to a server-environment token,
 * so GitHub work keeps flowing. Set `MYRMIDON_HOST_GITHUB_CREDENTIALS=1` to
 * restore the vendor's host mode — emergency rollback only, and the exact value
 * is required (see docs/myrmidon/SETTINGS.md).
 */

/** Emergency rollback to the vendor's host GitHub mode; see SETTINGS.md. */
export const HOST_GITHUB_CREDENTIALS_ENV = "MYRMIDON_HOST_GITHUB_CREDENTIALS";

/**
 * Vendor host mode is opt-in only, on the exact value `1` (no trimming: this is
 * an emergency switch, and the L2 precedent for one requires the exact value).
 * Any other value — `true`, `yes`, `on`, padded `" 1"`, `01` — keeps our closed
 * behavior: a typo must never silently reopen the credential transfer.
 */
export function hostGitHubCredentialTransferEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[HOST_GITHUB_CREDENTIALS_ENV] === "1";
}

/**
 * The mode the run actually gets. The vendor decision (`useHostGitHub` in
 * `services/heartbeat.ts`) is honored only when the emergency switch is on;
 * otherwise the run always takes the managed side.
 */
export function resolveRunHostGitHubCredentials(
  vendorUseHostGitHub: boolean,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return vendorUseHostGitHub && hostGitHubCredentialTransferEnabled(env);
}

/**
 * The names the controller's host probe copies into the run environment. Kept
 * in sync with that probe by hand; host-github-credentials.myrmidon.test.ts
 * reads `packages/adapter-utils/src/execution-target.ts` and fails when the
 * probe names a credential this list does not cover.
 */
export const HOST_GITHUB_CREDENTIAL_ENV_NAMES: readonly string[] = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "PAPERCLIP_GIT_TOKEN",
  "GH_CONFIG_DIR",
  "GIT_ASKPASS",
  "SSH_ASKPASS",
  "SSH_AUTH_SOCK",
  "GIT_SSH_COMMAND",
  "GIT_SSH",
  "PAPERCLIP_GITHUB_HOST_HOME",
];

const HOST_GITHUB_CREDENTIAL_ENV_PATTERN =
  /^(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN|PAPERCLIP_GIT_TOKEN|GH_CONFIG_DIR|GIT_ASKPASS|SSH_ASKPASS|SSH_AUTH_SOCK|GIT_SSH_COMMAND|GIT_SSH|PAPERCLIP_GITHUB_HOST_HOME|GIT_CONFIG_(?:KEY|VALUE)_\d+)$/;

/** True for a name that carries host GitHub credential material or its host home. */
export function isHostGitHubCredentialEnvKey(key: string): boolean {
  return HOST_GITHUB_CREDENTIAL_ENV_PATTERN.test(key);
}

/**
 * Drop every host-GitHub-credential name from an environment map. The identity
 * names (`GIT_AUTHOR_*` / `GIT_COMMITTER_*`) and the neutral
 * `GIT_CONFIG_GLOBAL` / `GIT_CONFIG_SYSTEM` / `GIT_CONFIG_NOSYSTEM` /
 * `GIT_CONFIG_COUNT` pointers stay: they carry no credential, and the managed
 * broker environment sets the pointers to `/dev/null` itself. Per-entry config
 * (`GIT_CONFIG_KEY_*` / `GIT_CONFIG_VALUE_*`) can carry a `credential.helper`,
 * so it goes.
 */
export function filterHostGitHubCredentialEnv<T extends Record<string, unknown>>(
  env: T,
): T {
  const filtered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(env)) {
    if (isHostGitHubCredentialEnvKey(key)) continue;
    filtered[key] = value;
  }
  return filtered as T;
}