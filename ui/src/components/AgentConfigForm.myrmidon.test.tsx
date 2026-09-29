// @vitest-environment jsdom

// myrmidon(W2b): the "Container" section inside the real agent form. The module
// mocks below are the ones AgentConfigForm.render.test.tsx uses to render the form.

import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "@paperclipai/shared";
import { getEnvironmentCapabilities } from "@paperclipai/shared";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ToastProvider } from "../context/ToastContext";
import { AgentConfigForm } from "./AgentConfigForm";
import { botContainerApi, type BotContainerStatus } from "./myrmidon/botContainerApi";
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
  getClaudeSetupTokenLoginPrompt: vi.fn(),
  submitClaudeSetupTokenBrowserCode: vi.fn(),
  completeClaudeSetupTokenLogin: vi.fn(),
  cancelClaudeSetupTokenLogin: vi.fn(),
  getClaudeOAuthTokenStatus: vi.fn(),
}));

// The default resume read for a test that does not exercise resume: no active
// session for the caller.
function noActiveSession() {
  return Promise.reject(
    new ApiError("Adapter login session not found", 404, { error: "Adapter login session not found" }),
  );
}

const mockClipboard = vi.hoisted(() => ({
  copyTextToClipboard: vi.fn(),
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

vi.mock("../api/agents", () => ({
  agentsApi: mockAgentsApi,
}));

vi.mock("../api/environments", () => ({
  environmentsApi: mockEnvironmentsApi,
}));

vi.mock("../api/instanceSettings", () => ({
  instanceSettingsApi: mockInstanceSettingsApi,
}));

vi.mock("../api/secrets", () => ({
  secretsApi: mockSecretsApi,
}));

vi.mock("../lib/clipboard", () => ({
  copyTextToClipboard: mockClipboard.copyTextToClipboard,
}));

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
    // The stand-in also records the two gates the form resolves for every
    // adapter, so a test can assert the plumbing without rendering a real
    // adapter's fields.
    ConfigFields: ({ adapterType, hideInstructionsFile, managedSandboxOnly }: {
      adapterType: string;
      hideInstructionsFile?: boolean;
      managedSandboxOnly?: boolean;
    }) =>
      adapterType === "hermes_gateway"
        ? <div data-testid="hermes-gateway-config-fields">Hermes Gateway fields</div>
        : (
          <div
            data-testid="adapter-config-fields"
            data-hide-instructions-file={String(hideInstructionsFile === true)}
            data-managed-sandbox-only={String(managedSandboxOnly === true)}
          />
        ),
    buildAdapterConfig: (values: { model?: string }) => ({
      model: values.model || undefined,
    }),
    parseStdoutLine: () => [],
  }),
}));

// The projected login capability per adapter type. The server projects these
// safe scalar fields. `codex_local` drives the displayed-code panel; `claude_local`
// drives the submitted-browser-code panel. A test overrides this map to add a
// third adapter with a projected login capability.
const mockLoginProjections = vi.hoisted(
  () =>
    new Map<string, { panelMode: string; timeoutPolicy: string }>([
      ["codex_local", { panelMode: "displayed_code", timeoutPolicy: "caller_bounded" }],
      ["grok_local", { panelMode: "displayed_code", timeoutPolicy: "caller_bounded" }],
      ["claude_local", { panelMode: "submitted_browser_code", timeoutPolicy: "fixed" }],
      // A third adapter, not a built-in, with a projected displayed-code login.
      ["vendor_local", { panelMode: "displayed_code", timeoutPolicy: "caller_bounded" }],
      // A non-built-in adapter with a submitted-browser-code login. Every login
      // runs on a real pseudo-terminal, so the gate requires the provider pty
      // capability from the login capability, not the adapter name.
      ["pty_vendor_local", { panelMode: "submitted_browser_code", timeoutPolicy: "fixed" }],
    ]),
);

vi.mock("../adapters/use-adapter-capabilities", () => ({
  useAdapterCapabilities: () => (adapterType: string) => {
    const login = mockLoginProjections.get(adapterType);
    return adapterType === "hermes_gateway"
      ? {
          supportsInstructionsBundle: false,
          supportsSkills: false,
          supportsLocalAgentJwt: false,
          requiresMaterializedRuntimeSkills: false,
          supportsAcp: false,
        }
      : {
          supportsInstructionsBundle: true,
          supportsSkills: true,
          supportsLocalAgentJwt: true,
          requiresMaterializedRuntimeSkills: false,
          supportsAcp: true,
          ...(login ? { login } : {}),
        };
  },
}));

vi.mock("../adapters/use-disabled-adapters", () => ({
  useDisabledAdaptersSync: () => [],
}));

vi.mock("./MarkdownEditor", () => ({
  MarkdownEditor: ({
    value,
    onChange,
    placeholder,
  }: {
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
  }) => (
    <textarea
      aria-label={placeholder ?? "Markdown"}
      value={value}
      onChange={(event) => onChange(event.currentTarget.value)}
    />
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const CAPABILITIES = getEnvironmentCapabilities(["claude_local", "codex_local"], {
  sandboxProviders: {
    daytona: { supportsLoginPty: true, displayName: "Daytona" },
    e2b: { supportsLoginPty: false, displayName: "E2B" },
  },
});

const CARD = { enabled: true, image: "bot-image:1", memoryMb: 2048, cpus: 1, pidsLimit: 512 };

const STATUS: BotContainerStatus = {
  enabled: true,
  runtimeConfigured: true,
  eligible: true,
  reason: null,
  imageAllowlist: ["bot-image:*"],
  imageAllowed: true,
  container: { state: "running", image: "bot-image:1" },
  containerError: null,
};

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function flushReact() {
  await act(async () => {
    for (let i = 0; i < 4; i += 1) {
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
    adapterType: "hermes_gateway",
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

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function renderForm(agentOverrides: Partial<Agent> = {}, onDirtyChange?: (dirty: boolean) => void) {
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
              onDirtyChange={onDirtyChange}
              showAdapterTypeField={false}
              showAdapterTestEnvironmentButton={false}
            />
          </TooltipProvider>
        </ToastProvider>
      </QueryClientProvider>,
    );
  });
  await flushReact();
  return { container, root, onSave };
}

function byId(container: HTMLElement, id: string) {
  return container.querySelector(`[data-testid="myrmidon-bot-container-${id}"]`) as HTMLElement | null;
}

function buttonByText(container: HTMLElement, label: string) {
  return [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
}

describe("myrmidon(W2b) agent form container section", () => {
  let roots: Root[] = [];
  const spyStatus = () => vi.spyOn(botContainerApi, "status").mockResolvedValue(STATUS);
  const spyApply = () =>
    vi.spyOn(botContainerApi, "apply").mockResolvedValue({ outcome: { kind: "unchanged" } });
  let statusSpy: ReturnType<typeof spyStatus>;
  let applySpy: ReturnType<typeof spyApply>;

  beforeEach(() => {
    mockAgentsApi.adapterModels.mockResolvedValue([]);
    mockAgentsApi.detectModel.mockResolvedValue(null);
    mockAgentsApi.list.mockResolvedValue([]);
    mockInstanceSettingsApi.get.mockResolvedValue({ defaultEnvironmentId: null });
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableEnvironments: true });
    mockInstanceSettingsApi.getGeneral.mockResolvedValue({ executionMode: "any" });
    mockEnvironmentsApi.capabilities.mockResolvedValue(CAPABILITIES);
    mockSecretsApi.list.mockResolvedValue([]);
    mockSecretsApi.listProposals.mockResolvedValue([]);
    const noSession = () =>
      Promise.reject(new ApiError("Adapter login session not found", 404, { error: "Adapter login session not found" }));
    mockAgentsApi.getActiveAdapterAuthLoginSession.mockImplementation(noSession);
    mockAgentsApi.getActiveClaudeSetupTokenLoginSession.mockImplementation(noSession);
    mockAgentsApi.getClaudeOAuthTokenStatus.mockResolvedValue(null);
    statusSpy = spyStatus();
    applySpy = spyApply();
  });

  afterEach(async () => {
    for (const root of roots) {
      await act(async () => {
        root.unmount();
      });
    }
    roots = [];
    document.body.innerHTML = "";
    statusSpy.mockRestore();
    applySpy.mockRestore();
    vi.clearAllMocks();
  });

  it("shows the section for a hermes_gateway agent, filled from its saved card", async () => {
    const result = await renderForm({ adapterConfig: { container: CARD } });
    roots.push(result.root);

    expect(buttonByText(result.container, "Container")).toBeTruthy();
    expect((byId(result.container, "image") as HTMLInputElement).value).toBe("bot-image:1");
    expect((byId(result.container, "memoryMb") as HTMLInputElement).value).toBe("2048");
    expect(statusSpy).toHaveBeenCalledWith("agent-1");
    expect(byId(result.container, "status")?.textContent).toBe("Running (bot-image:1)");
    expect((byId(result.container, "apply") as HTMLButtonElement).disabled).toBe(false);
  });

  it("does not show the section for other adapters", async () => {
    const result = await renderForm({ adapterType: "codex_local", adapterConfig: { container: CARD } });
    roots.push(result.root);

    expect(buttonByText(result.container, "Container")).toBeUndefined();
    expect(byId(result.container, "enabled")).toBeNull();
    expect(statusSpy).not.toHaveBeenCalled();
  });

  it("saves the section through the card Save with explicit defaults, and holds Apply until then", async () => {
    const result = await renderForm({ adapterConfig: {} });
    roots.push(result.root);

    await act(async () => buttonByText(result.container, "Container")!.click());
    await act(async () => byId(result.container, "enabled")!.click());
    await flushReact();
    await act(async () => setInputValue(byId(result.container, "image") as HTMLInputElement, "bot-image:1"));
    await flushReact();

    expect((byId(result.container, "apply") as HTMLButtonElement).disabled).toBe(true);
    expect(byId(result.container, "apply-hint")?.textContent).toContain("Save the card first");

    await act(async () => buttonByText(result.container, "Save")!.click());
    expect(result.onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        replaceAdapterConfig: true,
        adapterConfig: expect.objectContaining({ container: CARD }),
      }),
    );
  });

  it("applies the saved card from the form", async () => {
    const result = await renderForm({ adapterConfig: { container: CARD } });
    roots.push(result.root);

    await act(async () => byId(result.container, "apply")!.click());
    await flushReact();
    expect(applySpy).toHaveBeenCalledWith("agent-1");
    expect(byId(result.container, "feedback")?.textContent).toBe(
      "Nothing to change: the container already matches the card.",
    );
  });

  it("keeps an invalid number out of the card, and stores a valid one", async () => {
    const dirty = vi.fn();
    const result = await renderForm({ adapterConfig: { container: CARD } }, dirty);
    roots.push(result.root);

    await act(async () => setInputValue(byId(result.container, "memoryMb") as HTMLInputElement, "12"));
    await flushReact();
    expect(byId(result.container, "memoryMb-error")).toBeTruthy();
    expect(dirty).not.toHaveBeenCalledWith(true);

    await act(async () => setInputValue(byId(result.container, "memoryMb") as HTMLInputElement, "4096"));
    await flushReact();
    expect(byId(result.container, "memoryMb-error")).toBeNull();
    expect(dirty).toHaveBeenLastCalledWith(true);
    await act(async () => buttonByText(result.container, "Save")!.click());
    expect(result.onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        adapterConfig: expect.objectContaining({ container: { ...CARD, memoryMb: 4096 } }),
      }),
    );
  });
});
