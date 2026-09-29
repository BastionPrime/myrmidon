// myrmidon(PLS1): scope attribution for worker->host calls that carry no invocation id
// while a plugin API route call is in flight.
//
// Background. The host registers an invocation scope for every `handleApiRequest`
// call (the company id is the one the route resolved and authorised) and hands it to
// the worker. A worker built with a plugin SDK that echoes the invocation id sends
// it back on nested calls. A worker whose bundle contains an older SDK copy never
// echoes it, so every nested call that references a company was answered with
// "missing, expired, or unknown invocation scope".
//
// Rule. A worker->host call with NO invocation id at all is attributed to the
// company of the in-flight plugin API route calls, and only when ALL in-flight
// invocations of ANY kind (route calls, events, actions, data reads, tool calls,
// environment calls) belong to that one company. The host cannot tell which handler
// an un-echoed call came from, so an in-flight invocation of another company makes
// the attribution ambiguous and the call stays denied. A call with an unknown or
// forged id is not affected: it is still denied by the caller.
//
// Why this grants nothing new. The worker received the invocation id of each
// in-flight route call and could echo it on any nested call; attributing an
// un-echoed call to the same company yields the same scope. The scope is always
// the host-issued one, never a value from the worker, and a call that references
// another company still fails the company match in the host client.
//
// Cost. An `onEvent` invocation registered through `notify` lives up to its TTL
// (15 minutes), so an event of another company keeps the attribution denied for
// that long even if the handler has already finished.

export interface ApiRouteScopeCandidate {
  scope: { companyId: string };
  /** True only for an invocation the host registered for `handleApiRequest`. */
  apiRoute?: boolean;
}

/**
 * Pick the in-flight plugin API route invocation an un-echoed worker call is
 * attributed to. Returns `null` when there is no in-flight route invocation, or when
 * any in-flight invocation (of any kind) belongs to another company than the
 * route invocations, so the caller keeps denying the call.
 */
export function resolveUnechoedApiRouteInvocation<T extends ApiRouteScopeCandidate>(
  activeInvocations: Iterable<T>,
): T | null {
  let match: T | null = null;
  let companyId: string | null = null;
  for (const entry of activeInvocations) {
    if (companyId !== null && entry.scope.companyId !== companyId) return null;
    companyId = entry.scope.companyId;
    if (entry.apiRoute) match ??= entry;
  }
  return match;
}
