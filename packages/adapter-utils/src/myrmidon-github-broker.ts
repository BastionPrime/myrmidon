/**
 * Myrmidon (P6): broker candidate walk for the managed GitHub launcher.
 *
 * The server hands a run one GitHub credential broker URL: its public origin.
 * That origin is not always reachable from the run (for example behind a
 * client-certificate proxy), and then `gh`/`git` silently run without managed
 * credentials. The launcher therefore tries several candidate base URLs in
 * order until one answers:
 *
 *   PAPERCLIP_GITHUB_BROKER_URL -> PAPERCLIP_API_URL -> PAPERCLIP_RUNTIME_API_URL
 *   -> items of PAPERCLIP_RUNTIME_API_CANDIDATES_JSON
 *
 * at most GITHUB_BROKER_MAX_CANDIDATES, without duplicates. Each request is
 * bounded by GITHUB_BROKER_REQUEST_TIMEOUT_MS and the whole walk by
 * GITHUB_BROKER_TOTAL_TIMEOUT_MS. A 409 is retried on the same candidate, as
 * before. A failing candidate never stops the walk. Diagnostics name the tried
 * URLs and statuses, never tokens.
 *
 * The code below is plain JavaScript embedded into the launcher script, which
 * runs standalone on local, SSH and sandbox runtimes.
 */

export const GITHUB_BROKER_MAX_CANDIDATES = 6;
export const GITHUB_BROKER_REQUEST_TIMEOUT_MS = 10_000;
export const GITHUB_BROKER_TOTAL_TIMEOUT_MS = 60_000;
export const GITHUB_BROKER_CONFLICT_RETRY_DELAY_MS = 1_000;
export const GITHUB_BROKER_CONFLICT_MAX_ATTEMPTS = 30;

/**
 * Defines `paperclipBrokerCandidateUrls(env)` and
 * `paperclipRequestBrokerCredentials(env, candidateUrls, limits?)` for the
 * launcher script. The latter resolves to `{ response, tried }`: `response` is
 * the first ok response, else the last HTTP response, else null when no
 * candidate answered at all.
 */
export function githubBrokerCandidatesLauncherSource(): string {
  return String.raw`
function paperclipBrokerCandidateUrls(env) {
  const urls = [];
  const seen = new Set();
  const push = (value) => {
    const trimmed = typeof value === 'string' ? value.trim().replace(/\/+$/, '').replace(/\/api$/, '') : '';
    if (!trimmed || seen.has(trimmed) || urls.length >= ${GITHUB_BROKER_MAX_CANDIDATES}) return;
    seen.add(trimmed);
    urls.push(trimmed);
  };
  push(env.PAPERCLIP_GITHUB_BROKER_URL);
  push(env.PAPERCLIP_API_URL);
  push(env.PAPERCLIP_RUNTIME_API_URL);
  let extra = [];
  try {
    const parsed = JSON.parse(env.PAPERCLIP_RUNTIME_API_CANDIDATES_JSON || '[]');
    if (Array.isArray(parsed)) extra = parsed;
  } catch {}
  for (const item of extra) push(item);
  return urls;
}
async function paperclipRequestBrokerCredentials(env, candidateUrls, limits) {
  const requestTimeoutMs = (limits && limits.requestTimeoutMs) || ${GITHUB_BROKER_REQUEST_TIMEOUT_MS};
  const totalTimeoutMs = (limits && limits.totalTimeoutMs) || ${GITHUB_BROKER_TOTAL_TIMEOUT_MS};
  const retryDelayMs = (limits && limits.retryDelayMs) || ${GITHUB_BROKER_CONFLICT_RETRY_DELAY_MS};
  const deadline = Date.now() + totalTimeoutMs;
  const tried = [];
  let lastResponse = null;
  for (const base of candidateUrls) {
    const url = base + '/runtime-tools/github/credentials';
    let response = null;
    let outcome = 'no_response';
    try {
      for (let attempt = 0; attempt < ${GITHUB_BROKER_CONFLICT_MAX_ATTEMPTS}; attempt++) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) { outcome = 'budget_exhausted'; break; }
        response = await fetch(url, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(Math.min(requestTimeoutMs, remaining)),
          headers: { authorization: 'Bearer ' + (env.PAPERCLIP_GITHUB_BRIDGE_TOKEN || env.PAPERCLIP_API_KEY || env.PAPERCLIP_GITHUB_BROKER_TOKEN),
            'x-paperclip-github-capability': env.PAPERCLIP_GITHUB_BROKER_TOKEN, 'content-type': 'application/json' },
          body: '{}',
        });
        outcome = String(response.status);
        if (response.status !== 409) break;
        await response.arrayBuffer().catch(() => undefined);
        await new Promise(resolve => setTimeout(resolve, Math.max(0, Math.min(retryDelayMs, deadline - Date.now()))));
      }
    } catch (error) {
      // A dead or unreachable candidate must not stop the walk.
      response = null;
      outcome = error && error.name === 'TimeoutError' ? 'timeout' : 'no_response';
    }
    if (response && response.ok) return { response, tried };
    if (response) {
      lastResponse = response;
      await response.arrayBuffer().catch(() => undefined);
    }
    tried.push(url + ' -> ' + outcome);
    if (Date.now() >= deadline) break;
  }
  return { response: lastResponse, tried };
}
`;
}
