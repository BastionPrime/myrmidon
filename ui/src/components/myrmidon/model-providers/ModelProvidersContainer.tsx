// myrmidon(1.6.1 MODEL-PROVIDERS C): wire tier of the "Model providers"
// settings screen. Owns the react-query state: the GET view (providers +
// change log), the per-provider model list, and the add / rotate / remove /
// enable-models mutations. The layout lives in ModelProvidersScreen.tsx.
// Split mirrors the AUTONOMY-MATRIX B pattern so tests can drive the wire
// tier against a mocked API client.
//
// Key hygiene: the add and rotate forms hold the raw key in local state only
// for as long as the form is open; after a successful save the form state is
// cleared and only the API's key-free view ({ hasKey }) is rendered. The key
// is never written to any cache, DOM node or log line on this side.
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "@/i18n";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { ApiError } from "@/api/client";
import {
  modelProviderModelsQueryKey,
  modelProvidersApi,
  modelProvidersQueryKey,
  type AddModelProviderInput,
  type ModelProviderModelView,
  type ModelProvidersView,
} from "./modelProvidersApi";
import { ModelProvidersScreenView } from "./ModelProvidersScreen";

function readable(error: unknown): string {
  if (error instanceof ApiError) return error.message || `Request failed: ${error.status}`;
  if (error instanceof Error) return error.message;
  return "Unexpected error";
}

export function ModelProvidersScreen() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const companyId = selectedCompanyId ?? "";

  useEffect(() => {
    setBreadcrumbs([{ label: t("modelProviders.breadcrumb") }]);
  }, [setBreadcrumbs, t]);

  const queryKey = modelProvidersQueryKey(companyId);

  const viewQuery = useQuery({
    queryKey,
    queryFn: () => modelProvidersApi.view(companyId),
    enabled: companyId.length > 0,
  });
  const view: ModelProvidersView | undefined = viewQuery.data;

  const [mutationError, setMutationError] = useState<string | null>(null);
  const invalidate = () => queryClient.invalidateQueries({ queryKey });

  const addMutation = useMutation({
    mutationFn: (input: AddModelProviderInput) => modelProvidersApi.add(companyId, input),
    onMutate: () => setMutationError(null),
    onSuccess: () => {
      void invalidate();
    },
    onError: (err) => setMutationError(readable(err)),
  });

  const rotateMutation = useMutation({
    mutationFn: (input: { providerId: string; key: string }) =>
      modelProvidersApi.rotate(companyId, input.providerId, { key: input.key }),
    onMutate: () => setMutationError(null),
    onSuccess: () => {
      void invalidate();
    },
    onError: (err) => setMutationError(readable(err)),
  });

  const removeMutation = useMutation({
    mutationFn: (providerId: string) => modelProvidersApi.remove(companyId, providerId),
    onMutate: () => setMutationError(null),
    onSuccess: () => {
      void invalidate();
    },
    onError: (err) => setMutationError(readable(err)),
  });

  const updateModelsMutation = useMutation({
    mutationFn: (input: {
      providerId: string;
      models: Array<{ modelName: string; litellmModelName: string; enabled: boolean; free: boolean }>;
    }) => modelProvidersApi.updateModels(companyId, input.providerId, { models: input.models }),
    onMutate: () => setMutationError(null),
    onSuccess: (result, input) => {
      queryClient.setQueryData(
        modelProviderModelsQueryKey(companyId, input.providerId),
        { providerId: input.providerId, models: result.models },
      );
      void invalidate();
    },
    onError: (err) => setMutationError(readable(err)),
  });

  if (companyId.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="myrmidon-model-providers-no-company">
        {t("modelProviders.noCompany")}
      </p>
    );
  }

  if (viewQuery.isError) {
    return (
      <p className="text-sm text-destructive" data-testid="myrmidon-model-providers-error">
        {readable(viewQuery.error)}
      </p>
    );
  }

  if (viewQuery.isPending || !view) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="myrmidon-model-providers-loading">
        {t("modelProviders.loading")}
      </p>
    );
  }

  return (
    <ModelProvidersScreenView
      view={view}
      companyId={companyId}
      modelsQuery={(providerId: string) => modelProviderModelsQueryKey(companyId, providerId)}
      onAdd={(input) => addMutation.mutate(input)}
      adding={addMutation.isPending}
      addError={addMutation.isError ? readable(addMutation.error) : null}
      onRotate={(providerId, key) => rotateMutation.mutate({ providerId, key })}
      rotating={rotateMutation.isPending}
      onRemove={(providerId) => removeMutation.mutate(providerId)}
      removing={removeMutation.isPending}
      onToggleModel={(providerId, models) => updateModelsMutation.mutate({ providerId, models })}
      savingModels={updateModelsMutation.isPending}
      error={mutationError}
    />
  );
}
