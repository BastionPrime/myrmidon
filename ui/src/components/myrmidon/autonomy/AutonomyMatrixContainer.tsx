// myrmidon(1.6 AUTONOMY-MATRIX B): wire tier of the "Autonomy matrix" screen.
//
// Owns the react-query state: the GET view, the matrix PATCH (optimistic
// concurrency via expectedVersion), the regulation CRUD verbs, and the error
// surfaces. The layout lives in AutonomyMatrixScreen.tsx; this module keeps
// the working copy of the matrix (draft) so edits accumulate before one save.
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "@/i18n";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { ApiError } from "@/api/client";
import { AutonomyMatrixScreenView, type RegulationDraft } from "./AutonomyMatrixScreen";
import { autonomyApi, autonomyQueryKey, isVersionConflict } from "./autonomyApi";
// myrmidon(1.6.1 CUSTOM-CASTES C): role rows from the caste directory
import { useCasteOptions } from "@/components/myrmidon/castes/useCasteOptions";
import type {
  AutonomyActionClass,
  AutonomyMatrix,
  AutonomyVerdict,
} from "@paperclipai/shared";

function readable(error: unknown): string {
  if (error instanceof ApiError) return error.message || `Request failed: ${error.status}`;
  if (error instanceof Error) return error.message;
  return "Unexpected error";
}

export function AutonomyMatrixScreen() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const companyId = selectedCompanyId ?? "";

  useEffect(() => {
    setBreadcrumbs([{ label: t("autonomy.breadcrumb") }]);
  }, [setBreadcrumbs, t]);

  const [draft, setDraft] = useState<AutonomyMatrix | null>(null);
  const [matrixError, setMatrixError] = useState<string | null>(null);
  const [regulationError, setRegulationError] = useState<string | null>(null);

  // myrmidon(1.6.1 CUSTOM-CASTES C): the matrix rows and the regulation role
  // select come from the caste directory; the hook falls back to the
  // built-in twelve when the directory is unavailable.
  const { options: casteOptions } = useCasteOptions();

  const queryKey = autonomyQueryKey(companyId);
  const viewQuery = useQuery({
    queryKey,
    queryFn: () => autonomyApi.view(companyId),
    enabled: companyId.length > 0,
    retry: false,
  });

  const view = viewQuery.data;
  // A fresh server version resets the working copy (a save just landed).
  useEffect(() => {
    setDraft(null);
  }, [view?.matrix.version]);

  const invalidate = () => queryClient.invalidateQueries({ queryKey });

  const saveMatrix = useMutation({
    mutationFn: (patch: {
      expectedVersion?: number;
      rules: AutonomyMatrix["rules"];
      defaults: AutonomyMatrix["defaults"];
    }) => autonomyApi.updateMatrix(companyId, patch),
    onMutate: () => setMatrixError(null),
    onSuccess: () => {
      setDraft(null);
      void invalidate();
    },
    onError: (err) =>
      setMatrixError(isVersionConflict(err) ? t("autonomy.matrix.versionConflict") : readable(err)),
  });

  const regulationMutation = useMutation({
    mutationFn: (input: { kind: "create" | "update" | "approve" | "restore"; args: unknown[] }) => {
      switch (input.kind) {
        case "create": {
          const [value] = input.args as [RegulationDraft];
          return autonomyApi.createRegulation(companyId, {
            role: value.role,
            title: value.title,
            bodyMarkdown: value.bodyMarkdown,
          });
        }
        case "update": {
          const [id, value] = input.args as [string, { title: string; bodyMarkdown: string }];
          return autonomyApi.updateRegulation(companyId, id, value);
        }
        case "approve": {
          const [id] = input.args as [string];
          return autonomyApi.approveRegulation(companyId, id);
        }
        case "restore": {
          const [id, revision] = input.args as [string, number];
          return autonomyApi.restoreRegulationRevision(companyId, id, revision);
        }
      }
    },
    onMutate: () => setRegulationError(null),
    onSuccess: () => {
      setRegulationError(null);
      void invalidate();
    },
    onError: (err) => setRegulationError(readable(err)),
  });

  if (companyId.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="myrmidon-autonomy-no-company">
        {t("autonomy.noCompany")}
      </p>
    );
  }

  if (viewQuery.isError) {
    return (
      <p className="text-sm text-destructive" data-testid="myrmidon-autonomy-error">
        {readable(viewQuery.error)}
      </p>
    );
  }

  if (viewQuery.isPending || !view) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="myrmidon-autonomy-loading">
        {t("autonomy.loading")}
      </p>
    );
  }

  const matrix = draft ?? view.matrix;

  /** Cycle a role×action cell: allowed → approval_required → forbidden. */
  const cycleCell = (role: string, actionClass: AutonomyActionClass) => {
    const current = matrix.rules.find(
      (r) => r.role === role && r.actionClass === actionClass && r.agentId === undefined,
    );
    const stored = current ? current.verdict : matrix.defaults[actionClass];
    const next: AutonomyVerdict =
      stored === "allowed" ? "approval_required" : stored === "approval_required" ? "forbidden" : "allowed";
    const rules = matrix.rules.filter(
      (r) => !(r.role === role && r.actionClass === actionClass && r.agentId === undefined),
    );
    if (next !== matrix.defaults[actionClass]) {
      rules.push({ role, actionClass, verdict: next });
    }
    setDraft({ ...matrix, rules });
  };

  /** Change the default verdict of one action class. */
  const changeDefault = (actionClass: AutonomyActionClass, verdict: AutonomyVerdict) => {
    // Cells that matched the old default become redundant; cells matching
    // the new default drop out the same way.
    const rules = matrix.rules.filter(
      (r) => !(r.actionClass === actionClass && r.agentId === undefined && r.verdict === verdict),
    );
    setDraft({ ...matrix, defaults: { ...matrix.defaults, [actionClass]: verdict }, rules });
  };

  return (
    <AutonomyMatrixScreenView
      view={view}
      matrix={matrix}
      matrixDirty={draft !== null}
      roleOptions={casteOptions}
      onCellClick={cycleCell}
      onDefaultChange={changeDefault}
      onSaveMatrix={() =>
        saveMatrix.mutate({
          expectedVersion: view.matrix.version,
          rules: matrix.rules,
          defaults: matrix.defaults,
        })
      }
      savingMatrix={saveMatrix.isPending}
      matrixError={matrixError}
      regulationError={regulationError}
      pendingRegulationId={null}
      onCreateRegulation={(input) => regulationMutation.mutate({ kind: "create", args: [input] })}
      onUpdateRegulation={(id, input) => regulationMutation.mutate({ kind: "update", args: [id, input] })}
      onApproveRegulation={(id) => regulationMutation.mutate({ kind: "approve", args: [id] })}
      onRestoreRevision={(id, revision) =>
        regulationMutation.mutate({ kind: "restore", args: [id, revision] })
      }
    />
  );
}
