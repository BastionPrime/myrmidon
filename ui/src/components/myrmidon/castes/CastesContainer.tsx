// myrmidon(1.6.1 CUSTOM-CASTES C): wire tier of the "Agent castes" settings
// screen. Owns the react-query state: the GET directory (the first read
// seeds the 12 built-in castes server-side) and the add / update / remove
// mutations. The layout lives in CastesScreen.tsx. Split mirrors the
// model-providers pattern so tests can drive the wire tier against a mocked
// API client.
import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "@/i18n";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { ApiError } from "@/api/client";
import {
  castesApi,
  castesQueryKey,
  type AddCasteInput,
  type CasteView,
  type UpdateCasteInput,
} from "./castesApi";
import { CastesScreenView } from "./CastesScreen";

function readable(error: unknown): string {
  if (error instanceof ApiError) return error.message || `Request failed: ${error.status}`;
  if (error instanceof Error) return error.message;
  return "Unexpected error";
}

/** 409 from the DELETE means live agents still hold this role. */
export function isCasteInUse(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "status" in err &&
    (err as { status?: unknown }).status === 409
  );
}

export function CastesScreen() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const companyId = selectedCompanyId ?? "";

  useEffect(() => {
    setBreadcrumbs([{ label: t("castes.breadcrumb") }]);
  }, [setBreadcrumbs, t]);

  const queryKey = castesQueryKey(companyId);

  const viewQuery = useQuery({
    queryKey,
    queryFn: () => castesApi.view(companyId),
    enabled: companyId.length > 0,
  });
  const castes: CasteView[] | undefined = viewQuery.data?.castes;

  const invalidate = () => queryClient.invalidateQueries({ queryKey });

  const addMutation = useMutation({
    mutationFn: (input: AddCasteInput) => castesApi.add(companyId, input),
    onSuccess: () => {
      void invalidate();
    },
  });

  const updateMutation = useMutation({
    mutationFn: (input: { key: string; patch: UpdateCasteInput }) =>
      castesApi.update(companyId, input.key, input.patch),
    onSuccess: () => {
      void invalidate();
    },
  });

  const removeMutation = useMutation({
    mutationFn: (key: string) => castesApi.remove(companyId, key),
    onSuccess: () => {
      void invalidate();
    },
  });

  if (companyId.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="myrmidon-castes-no-company">
        {t("castes.noCompany")}
      </p>
    );
  }

  if (viewQuery.isError) {
    return (
      <p className="text-sm text-destructive" data-testid="myrmidon-castes-error">
        {readable(viewQuery.error)}
      </p>
    );
  }

  if (viewQuery.isPending || !castes) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="myrmidon-castes-loading">
        {t("castes.loading")}
      </p>
    );
  }

  return (
    <CastesScreenView
      castes={castes}
      onAdd={(input) => addMutation.mutate(input)}
      adding={addMutation.isPending}
      addError={addMutation.isError ? readable(addMutation.error) : null}
      onUpdate={(key, patch) => updateMutation.mutate({ key, patch })}
      updating={updateMutation.isPending}
      onRemove={(key) => removeMutation.mutate(key)}
      removing={removeMutation.isPending}
      error={
        removeMutation.isError
          ? isCasteInUse(removeMutation.error)
            ? t("castes.remove.inUse")
            : readable(removeMutation.error)
          : updateMutation.isError
            ? readable(updateMutation.error)
            : null
      }
    />
  );
}
