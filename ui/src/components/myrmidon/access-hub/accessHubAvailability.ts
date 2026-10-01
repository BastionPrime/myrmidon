// Availability of the access-hub server API on this instance.
//
// The screen ships before the server part: an instance that does not serve
// `/api/myrmidon/access-hub` answers 404 (no such route) or 501 (route
// declared, handler not built yet). Neither is a failure of the operator's
// request — the server simply has nothing to offer yet — so the UI reports a
// "not available yet" state instead of an error, and the settings navigation
// marks the entry until the API appears.
import { useQuery } from "@tanstack/react-query";
import { ApiError } from "@/api/client";
import { accessHubApi, accessHubQueryKeys } from "./accessHubApi";

export type AccessHubAvailability = "unknown" | "available" | "unavailable";

/** 404 (no route) and 501 (route without a handler) both mean "no API here yet". */
export function accessHubUnavailable(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 404 || error.status === 501);
}

/**
 * React-query retry predicate for the access-hub endpoints: a missing route is
 * a stable answer, so retrying only delays the notice. Real failures keep the
 * default retry budget.
 */
export function accessHubQueryRetry(failureCount: number, error: unknown): boolean {
  if (accessHubUnavailable(error)) return false;
  return failureCount < 3;
}

/**
 * Which state the access-hub API is in, read from the shared access-list
 * query: the screen and the settings navigation observe the same cache entry,
 * so the probe costs one request per session.
 */
export function useAccessHubAvailability(
  companyId: string | null | undefined,
  enabled = true,
): AccessHubAvailability {
  const query = useQuery({
    queryKey: accessHubQueryKeys.accesses,
    queryFn: accessHubApi.listAccesses,
    enabled: Boolean(companyId) && enabled,
    retry: accessHubQueryRetry,
  });
  if (accessHubUnavailable(query.error)) return "unavailable";
  if (query.isSuccess) return "available";
  return "unknown";
}