// myrmidon(UI-0a): UI-2.0 shell — own clean-room tree (owner decision 02.10:
// new components under ui/src/ui2/, no edits to vendor UI files beyond the
// single mount point in App.tsx and the token import in index.css).
//
// Hook for the instance experimental flag `enableMyrmidonUi2` (default off).
// Reads through the shared instanceSettingsApi query cache (same cache key
// as every other experimental-flag hook, so no extra request). Missing
// settings, loading and read failures all resolve to `false`: the 2.0 shell
// is opt-in and must never flash or self-activate on a read error.
import { useContext } from "react";
import { QueryClient, QueryClientContext, useQuery } from "@tanstack/react-query";
import type { InstanceExperimentalSettings } from "@paperclipai/shared";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { queryKeys } from "@/lib/queryKeys";

export function resolveMyrmidonUi2Enabled(
  settings: Pick<InstanceExperimentalSettings, "enableMyrmidonUi2"> | null | undefined,
): boolean {
  return settings?.enableMyrmidonUi2 === true;
}

let detachedClient: QueryClient | null = null;
function getDetachedClient(): QueryClient {
  detachedClient ??= new QueryClient();
  return detachedClient;
}

export function useMyrmidonUi2Enabled(): { enabled: boolean; loaded: boolean } {
  const contextClient = useContext(QueryClientContext);
  const query = useQuery(
    {
      queryKey: queryKeys.instance.experimentalSettings,
      queryFn: () => instanceSettingsApi.getExperimental(),
      enabled: contextClient != null,
    },
    contextClient ?? getDetachedClient(),
  );

  if (!contextClient) return { enabled: false, loaded: true };

  return {
    enabled: resolveMyrmidonUi2Enabled(query.data),
    loaded: query.isFetched,
  };
}
