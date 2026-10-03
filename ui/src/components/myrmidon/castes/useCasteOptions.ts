// myrmidon(1.6.1 CUSTOM-CASTES C): the shared read side of the caste
// directory for the pickers — the agent card's role select, the autonomy
// matrix role lists and the onboarding role select all pull the company's
// castes from here instead of the hardcoded 12-role constant.
//
// Fallback contract (tested in each consumer): when the directory is
// unavailable — error, empty, or no company selected — every consumer falls
// back to the built-in AGENT_ROLES/AGENT_ROLE_LABELS pairs, so the UI never
// loses its role picker while the Part A API is absent or failing.
import { useQuery } from "@tanstack/react-query";
import { AGENT_ROLES, AGENT_ROLE_LABELS } from "@paperclipai/shared";
import { useCompany } from "@/context/CompanyContext";
import { castesApi, castesQueryKey, type CasteView } from "@/components/myrmidon/castes/castesApi";

export interface CasteOption {
  key: string;
  label: string;
}

const BUILTIN_OPTIONS: CasteOption[] = AGENT_ROLES.map((role) => ({
  key: role,
  label: AGENT_ROLE_LABELS[role],
}));

/** Directory options for one explicit company; built-ins are the fallback. */
export function useCasteOptionsForCompany(companyId: string | undefined): {
  options: CasteOption[];
  fromDirectory: boolean;
} {
  const id = companyId ?? "";
  const query = useQuery({
    queryKey: castesQueryKey(id || "none"),
    queryFn: () => castesApi.view(id),
    enabled: id.length > 0,
    retry: false,
  });
  return resolveCasteOptions(query.data?.castes);
}

function resolveCasteOptions(directory: CasteView[] | undefined): {
  options: CasteOption[];
  fromDirectory: boolean;
} {
  if (!directory || directory.length === 0) {
    return { options: BUILTIN_OPTIONS, fromDirectory: false };
  }
  const byKey = new Map(directory.map((caste) => [caste.key, caste]));
  const options: CasteOption[] = directory.map((caste) => ({
    key: caste.key,
    label: caste.nameRu || caste.nameEn || caste.key,
  }));
  // Built-ins the directory has not seeded yet stay selectable so an agent
  // holding one of them keeps a matching option.
  for (const builtin of BUILTIN_OPTIONS) {
    if (!byKey.has(builtin.key)) options.push(builtin);
  }
  return { options, fromDirectory: true };
}

/**
 * The role/caste options for every picker, from the currently selected
 * company's directory. Directory entries win (RU name first, then EN, then
 * the key); anything the directory lacks falls back to the built-in labels;
 * a failed or empty directory falls back entirely.
 */
export function useCasteOptions(): { options: CasteOption[]; fromDirectory: boolean } {
  const { selectedCompanyId } = useCompany();
  return useCasteOptionsForCompany(selectedCompanyId ?? undefined);
}

/** The display label for a stored role, preferring the directory entry. */
export function casteLabelFor(role: string, options: CasteOption[]): string {
  return options.find((option) => option.key === role)?.label ?? role;
}
