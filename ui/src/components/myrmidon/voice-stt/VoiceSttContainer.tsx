// myrmidon(1.6.1 VOICE-STT C): wire tier of the "Speech recognition (STT)"
// settings screen. Owns the react-query state: the GET record and the PATCH
// mutation. The layout + local form state live in VoiceSttScreen.tsx so tests
// can drive the wire tier against a mocked API client.
//
// Key hygiene: the record's key fields carry the secret NAMES only (the values
// live server-side in the company secret store); this side never sees a value,
// so nothing value-like can enter props, cache, or DOM. A save invalidates the
// query so the canonical record re-renders.
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "@/i18n";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { ApiError } from "@/api/client";
import {
  diffFromSettings,
  formFromSettings,
  VoiceSttScreenView,
  type VoiceSttFormState,
} from "./VoiceSttScreen";
import { voiceSttApi, voiceSttQueryKey, type VoiceSttUpdateInput } from "./voiceSttApi";

function readable(error: unknown): string {
  if (error instanceof ApiError) return error.message || `Request failed: ${error.status}`;
  if (error instanceof Error) return error.message;
  return "Unexpected error";
}

export function VoiceSttScreen() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const companyId = selectedCompanyId ?? "";

  useEffect(() => {
    setBreadcrumbs([{ label: t("voiceStt.breadcrumb") }]);
  }, [setBreadcrumbs, t]);

  const queryKey = voiceSttQueryKey(companyId);

  const settingsQuery = useQuery({
    queryKey,
    queryFn: () => voiceSttApi.view(companyId),
    enabled: companyId.length > 0,
  });

  const [form, setForm] = useState<VoiceSttFormState | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);

  const settings = settingsQuery.data;
  const dirty =
    form !== null && settings !== undefined
      ? Object.keys(diffFromSettings(form, settings)).length > 0
      : false;

  const updateMutation = useMutation({
    mutationFn: (input: VoiceSttUpdateInput) => voiceSttApi.update(companyId, input),
    onMutate: () => setMutationError(null),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey });
    },
    onError: (err) => setMutationError(readable(err)),
  });

  if (companyId.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="myrmidon-voice-stt-no-company">
        {t("voiceStt.noCompany")}
      </p>
    );
  }

  if (settingsQuery.isError) {
    return (
      <p className="text-sm text-destructive" data-testid="myrmidon-voice-stt-error">
        {readable(settingsQuery.error)}
      </p>
    );
  }

  if (settingsQuery.isPending || !settings) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="myrmidon-voice-stt-loading">
        {t("voiceStt.loading")}
      </p>
    );
  }

  return (
    <VoiceSttScreenView
      settings={settings}
      saving={updateMutation.isPending}
      error={mutationError}
      dirty={dirty}
      onChange={setForm}
      onSave={(input) => updateMutation.mutate(input)}
    />
  );
}
