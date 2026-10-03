// @vitest-environment jsdom

// myrmidon(1.6.1 MODEL-PROVIDERS D): the agent-card model picker reads the
// enabled models from the board DB (GET /adapters/:type/models, which the
// MODEL-PROVIDERS A backend backs with the DB + env bootstrap fallback). The
// picker must show the free/paid badge, free models first, and a model that
// appears in the API list later must show up without a page reload.

import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "@paperclipai/shared";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ToastProvider } from "../context/ToastContext";
import { AgentConfigForm } from "./AgentConfigForm";
import { ApiError } from "../api/client";

const mockAgentsApi = vi.hoisted(() => ({
  adapterModels: vi.fn(),
  detectModel: vi.fn(),
  list: vi.fn(),
  testEnvironment: vi.fn(),
  startAdapterAuthLogin: vi.fn(),
  getAdapterAuthLoginStatus: vi.fn(),
  getActiveAdapterAuthLoginSession: vi.fn(),
  cancelAdapterAuthLogin: vi.fn(),
  startClaudeSetupTokenLogin: vi.fn(),
  getClaudeSetupTokenLoginStatus: vi.fn(),
  getActiveClaudeSetupTokenLoginSession: vi.fn(),
  getActiveClaudeSetupTokenLoginPrompt: vi.fn(),
  submitClaudeSetupTokenBrowserCode: vi.fn(),
  completeClaudeSetupTokenLogin: vi.fn(),
  cancelClaudeSetupTokenLogin: vi.fn(),
  getClaudeOAuthTokenStatus: vi.fn(),
}));

const mockEnvironmentsApi = vi.hoisted(() => ({
  list: vi.fn(),
  capabilities: vi.fn(),
}));

const mockInstanceSettingsApi = vi.hoisted(() => ({
  get: vi.fn(),
  getExperimental: vi.fn(),
  getGeneral: vi.fn(),
}));

const mockSecretsApi = vi.hoisted(() => ({
  list: vi.fn(),
  listProposals: vi.fn(),
  listUserSecretDefinitions: vi.fn(async () => [] as unknown[]),
}));

vi.mock("../api/agents", () => ({ agentsApi: mockAgentsApi }));
vi.mock("../api/environments", () => ({ environmentsApi: mockEnvironmentsApi }));
vi.mock("../api/instanceSettings", () => ({ instanceSettingsApi: mockInstanceSettingsApi }));
vi.mock("../api/secrets", () => ({ secretsApi: mockSecretsApi }));
vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [{ id: "company-1", name: "Paperclip" }],
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", name: "Paperclip" },
    selectionSource: "bootstrap",
    loading: false,
    error: null,
    setSelectedCompanyId: vi.fn(),
    reloadCompanies: vi.fn(),
    createCompany: vi.fn(),
  }),
}));
vi.mock("../adapters", () => ({
  getUIAdapter: (type: string) => ({
    type,
    label: type === "hermes_gateway" ? "Hermes Gateway" : "Codex",
    ConfigFields: () => <div data-testid="adapter-config-fields" />,
    buildAdapterConfig: (values: { model?: string }) => ({ model: values.model || undefined }),
    parseStdoutLine: () => [],
  }),
}));
vi.mock("../adapters/use-adapter-capabilities", () => ({
  useAdapterCapabilities: () => () => ({
    supportsInstructionsBundle: true,
    supportsSkills: true,
    supportsLocalAgentJwt: true,
    requiresMaterializedRuntimeSkills: false,
    supportsAcp: true,
  }),
}));
vi.mock("../adapters/use-disabled-adapters", () => ({ useDisabledAdaptersSync: () => [] }));
vi.mock("./MarkdownEditor", () => ({
  MarkdownEditor: ({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) => (
    <textarea aria-label={placeholder ?? "Markdown"} value={value} onChange={(e) => onChange(e.currentTarget.value)} />
  ),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const noSession = () =>
  Promise.reject(new ApiError("Adapter login session not found", 404, { error: "Adapter login session not found" }));

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => { result = callback(); });
  await result;
}

async function flushReact() {
  await act(async () => {
    for (let i = 0; i < 8; i += 1) {
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    }
  });
}

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-1",
    companyId: "company-1",
    name: "Cody",
    role: "Engineer",
    title: null,
    icon: null,
    status: "idle",
    reportsTo: null,
    capabilities: null,
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: {},
    defaultEnvironmentId: null,
    contextMode: "thin",
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    permissions: {},
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  } as Agent;
}

async function renderForm(agentOverrides: Partial<Agent> = {}) {
  mockEnvironmentsApi.list.mockResolvedValue([]);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const onSave = vi.fn();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <TooltipProvider>
            <AgentConfigForm
              mode="edit"
              agent={makeAgent(agentOverrides)}
              onSave={onSave}
              hidePromptTemplate
              showAdapterTypeField={false}
              showAdapterTestEnvironmentButton={false}
            />
          </TooltipProvider>
        </ToastProvider>
      </QueryClientProvider>,
    );
  });
  await flushReact();
  return { container, root, onSave, queryClient };
}

/**
 * The ModelDropdown trigger button: it shows the current model id (the saved
 * `adapterConfig.model`) or "Select model" when empty, next to a chevron.
 */
function modelTrigger(container: HTMLElement, currentModel: string) {
  return Array.from(container.querySelectorAll("button")).find(
    (b) => (b.textContent ?? "").trim().startsWith(currentModel) && (b.textContent ?? "").includes("Select model") === false,
  ) ?? Array.from(container.querySelectorAll("button")).find(
    (b) => (b.textContent ?? "").includes(currentModel),
  );
}

describe("myrmidon(1.6.1 MODEL-PROVIDERS D) card model picker", () => {
  let roots: Root[] = [];

  afterEach(() => {
    while (roots.length) roots.pop()?.unmount();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  beforeEach(() => {
    mockAgentsApi.adapterModels.mockResolvedValue([]);
    mockAgentsApi.detectModel.mockResolvedValue(null);
    mockAgentsApi.list.mockResolvedValue([]);
    mockInstanceSettingsApi.get.mockResolvedValue({ defaultEnvironmentId: null });
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableEnvironments: true });
    mockInstanceSettingsApi.getGeneral.mockResolvedValue({ executionMode: "any" });
    mockEnvironmentsApi.capabilities.mockResolvedValue({ sandboxProviders: {} });
    mockSecretsApi.list.mockResolvedValue([]);
    mockSecretsApi.listProposals.mockResolvedValue([]);
    mockAgentsApi.getActiveAdapterAuthLoginSession.mockImplementation(noSession);
    mockAgentsApi.getActiveClaudeSetupTokenLoginSession.mockImplementation(noSession);
    mockAgentsApi.getClaudeOAuthTokenStatus.mockResolvedValue(null);
  });

  it("shows the free/paid badge and lists free models first", async () => {
    mockAgentsApi.adapterModels.mockResolvedValue([
      { id: "paid-model", label: "paid-model", pricing: "paid" },
      { id: "zeta-free", label: "zeta-free", pricing: "free" },
      { id: "alpha-free", label: "alpha-free", pricing: "free" },
    ]);
    const result = await renderForm({ adapterConfig: { model: "alpha-free" } });
    roots.push(result.root);

    const trigger = modelTrigger(result.container, "alpha-free");
    expect(trigger).toBeTruthy();
    await act(async () => {
      trigger!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    const badges = Array.from(document.body.querySelectorAll("[data-model-pricing]"));
    expect(badges.map((b) => b.getAttribute("data-model-pricing"))).toContain("free");
    expect(badges.map((b) => b.getAttribute("data-model-pricing"))).toContain("paid");

    // Free first: the first listed entry is a free model.
    expect(badges[0]?.getAttribute("data-model-pricing")).toBe("free");
    // Button text includes the model id plus the badge label, so compare
    // contains-based indices of the free entries against the paid one.
    const order = badges.map((b) => b.closest("button")?.textContent ?? "");
    const pos = (needle: string) => order.findIndex((text) => text.includes(needle));
    expect(pos("alpha-free")).toBeGreaterThanOrEqual(0);
    expect(pos("zeta-free")).toBeGreaterThanOrEqual(0);
    expect(pos("paid-model")).toBeGreaterThanOrEqual(0);
    expect(pos("alpha-free")).toBeLessThan(pos("paid-model"));
    expect(pos("zeta-free")).toBeLessThan(pos("paid-model"));
  });

  it("falls back to the env bootstrap default list when the DB list is empty", async () => {
    // The server falls back to PAPERCLIP_ADAPTER_MODELS; the UI sees a plain
    // list without pricing flags and renders no badges.
    mockAgentsApi.adapterModels.mockResolvedValue([
      { id: "env-default-model", label: "env-default-model" },
    ]);
    const result = await renderForm({ adapterConfig: { model: "env-default-model" } });
    roots.push(result.root);

    const trigger = modelTrigger(result.container, "env-default-model");
    await act(async () => {
      trigger!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(document.body.textContent).toContain("env-default-model");
    expect(document.body.querySelectorAll("[data-model-pricing]").length).toBe(0);
  });

  it("shows a model that appears in the API list after the form was rendered, without a reload", async () => {
    // First fetch: the DB list has one model. The card is rendered and open.
    mockAgentsApi.adapterModels.mockResolvedValue([
      { id: "old-model", label: "old-model", pricing: "paid" },
    ]);
    const result = await renderForm({ adapterConfig: { model: "old-model" } });
    roots.push(result.root);

    const trigger = modelTrigger(result.container, "old-model");
    await act(async () => {
      trigger!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    expect(document.body.textContent).toContain("old-model");
    expect(document.body.textContent).not.toContain("new-free-model");

    // The list changes on the board (settings write) — the next poll/refresh
    // returns the new enabled model. The same mounted card must show it.
    mockAgentsApi.adapterModels.mockResolvedValue([
      { id: "old-model", label: "old-model", pricing: "paid" },
      { id: "new-free-model", label: "new-free-model", pricing: "free" },
    ]);
    await act(async () => {
      void result.queryClient.invalidateQueries();
    });
    await flushReact();

    expect(document.body.textContent).toContain("new-free-model");
    const badges = Array.from(document.body.querySelectorAll("[data-model-pricing]"));
    expect(badges[0]?.getAttribute("data-model-pricing")).toBe("free");
  });
});
