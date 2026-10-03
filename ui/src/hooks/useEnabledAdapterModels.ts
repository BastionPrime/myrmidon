import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { agentsApi, type AdapterModel } from "@/api/agents";
import { queryKeys } from "@/lib/queryKeys";

/**
 * myrmidon(1.6.1 MODEL-PROVIDERS D): the enabled model list the agent card
 * pickers read. The source of truth is the board DB (the models registered
 * through the Model providers settings, see MODEL-PROVIDERS A/C); the
 * PAPERCLIP_ADAPTER_MODELS env stays a bootstrap default the server falls
 * back to when the DB has no rows. New models must appear on the cards
 * without a page reload or a board restart, so the query is short-lived and
 * refetches on the shared polling cadence while any picker is mounted.
 */

/** How often the enabled model list is re-read from the board. */
export const ENABLED_MODELS_POLL_MS = 15_000;

/** Sort the picker list: free first, then alphabetical by id. */
export function sortModelsFreeFirst(models: AdapterModel[]): AdapterModel[] {
  return [...models].sort((a, b) => {
    const aFree = a.pricing === "free";
    const bFree = b.pricing === "free";
    if (aFree !== bFree) return aFree ? -1 : 1;
    return a.id.localeCompare(b.id);
  });
}

/**
 * Reads the enabled models for one adapter type and keeps the card's copy
 * fresh. Returns an empty list (not an error state) while the company or
 * adapter is unknown so callers can fall back to their own defaults.
 */
export function useEnabledAdapterModels(companyId: string | null | undefined, adapterType: string | null | undefined) {
  const queryClient = useQueryClient();
  const key = queryKeys.agents.adapterModels(companyId ?? "none", adapterType ?? "none", null, undefined);

  const query = useQuery({
    queryKey: key,
    queryFn: () => agentsApi.adapterModels(companyId!, adapterType!, { environmentId: null }),
    enabled: Boolean(companyId && adapterType),
    // The list is small and must reflect DB changes quickly; a card is often
    // open for a long time, so the data is never served stale for long and
    // the poll below re-reads it in the background.
    staleTime: 0,
    refetchOnWindowFocus: true,
  });

  const refresh = useRef(() => void queryClient.invalidateQueries({ queryKey: key }));
  refresh.current = () => void queryClient.invalidateQueries({ queryKey: key });

  // Background polling: a model enabled in the settings shows up in the
  // pickers without a reload. The interval stays active only while the
  // component using the list is mounted.
  useEffect(() => {
    if (!companyId || !adapterType) return;
    const timer = window.setInterval(() => refresh.current(), ENABLED_MODELS_POLL_MS);
    return () => window.clearInterval(timer);
  }, [companyId, adapterType]);

  return {
    models: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error,
    refresh: () => refresh.current(),
  };
}
