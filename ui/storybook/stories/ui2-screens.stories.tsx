// ui/storybook/stories/ui2-screens.stories.tsx
//
// myrmidon(UI2): visual stories for the six ui2 screens. The storybook
// preview already mounts QueryClient/Router/CompanyProvider with a mocked
// `/api/companies` listing exactly `company-storybook` — the provider then
// selects it automatically, so `useCompany()` inside the screens resolves.
// This file adds a story-level fetch mock answering the screen-specific
// endpoints for that same company id. The visual suite screenshots every
// story in dark + light at the registered viewports, mobile 390 and
// desktop 1440 included.

import type { Meta, StoryObj } from "@storybook/react-vite";
import type { Agent, HeartbeatRun } from "@paperclipai/shared";
import { storybookAgents } from "../fixtures/paperclipData";
import { Ui2Decisions } from "@/ui2/screens/decisions/Ui2Decisions";
import { Ui2Costs } from "@/ui2/screens/costs/Ui2Costs";
import { Ui2AgentOverview } from "@/ui2/screens/agent-overview/Ui2AgentOverview";
import { Ui2RunsSettings } from "@/ui2/screens/settings/runs-queue/Ui2RunsSettings";
import { Ui2SystemSettings } from "@/ui2/screens/settings/system/Ui2SystemSettings";
import { Ui2LanguageSettings } from "@/ui2/screens/settings/language/Ui2LanguageSettings";
import { Ui2I18nProvider } from "@/ui2/i18n/Ui2I18n";
import type { Ui2Locale } from "@/ui2/i18n/locales";

const COMPANY_ID = "company-storybook";
// The ui2 overview stories render the first storybook agent (CodexCoder).
const agentFixture: Agent = storybookAgents[0];
const AGENT_ID = agentFixture.id;

const NOW = new Date("2026-10-02T12:00:00.000Z").getTime();
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

const fixtures = {
  decisions: [
    {
      id: "d1",
      companyId: COMPANY_ID,
      bundleId: null,
      originAgentId: AGENT_ID,
      originIssueId: "issue-1",
      originRunId: "run-1",
      ruleKey: "budget_raise",
      title: "Raise the soft limit for the day",
      body: "The colony spends faster than planned. Choose how to continue.",
      options: [
        {
          id: "opt-raise",
          label: "Raise by $1",
          description: "Extends the window without unpausing other agents.",
          style: "recommended",
          effects: [
            { type: "comment_on_issue", targetIssueId: "issue-1", staleness: "strict", bodyMarkdown: "raised" },
          ],
        },
        {
          id: "opt-keep",
          label: "Keep paused",
          effects: [
            { type: "update_issue_status", targetIssueId: "issue-1", staleness: "strict", status: "in_progress" },
          ],
        },
      ],
      inputs: [
        { id: "amount", label: "Amount", placeholder: "1.00", required: true, maxLength: 8 },
      ],
      status: "open",
      executionStatus: null,
      chosenOptionId: null,
      inputValues: null,
      decidedByUserId: null,
      decidedAt: null,
      expiresAt: minutesAgo(-120),
      idempotencyKey: null,
      targetSnapshots: {},
      continuationPolicy: "none",
      metadata: {},
      createdAt: minutesAgo(125),
      updatedAt: minutesAgo(125),
      targetChanged: {},
    },
    {
      id: "d2",
      companyId: COMPANY_ID,
      bundleId: null,
      originAgentId: AGENT_ID,
      originIssueId: "issue-2",
      originRunId: "run-2",
      ruleKey: "owner_email_reply",
      title: "Reply to the client by email",
      body: "The draft is ready; sending cannot be recalled.",
      options: [
        { id: "opt-send", label: "Send", effects: [{ type: "assign_issue", targetIssueId: "issue-2", staleness: "strict", assigneeAgentId: null, assigneeUserId: null }] },
      ],
      inputs: null,
      status: "open",
      executionStatus: null,
      chosenOptionId: null,
      inputValues: null,
      decidedByUserId: null,
      decidedAt: null,
      expiresAt: minutesAgo(-600),
      idempotencyKey: null,
      targetSnapshots: {},
      continuationPolicy: "none",
      metadata: {},
      createdAt: minutesAgo(320),
      updatedAt: minutesAgo(320),
      targetChanged: {},
    },
  ],
  agents: [
    {
      id: AGENT_ID,
      companyId: COMPANY_ID,
      name: "agent-a",
      status: "active",
      role: "engineer",
      adapterType: "claude_local",
    },
  ],
  costSummary: {
    companyId: COMPANY_ID,
    spendCents: 157_400,
    budgetCents: 220_000,
    utilizationPercent: 71.5,
  },
  byAgent: [
    {
      agentId: AGENT_ID,
      agentName: "agent-a",
      agentStatus: "active",
      costCents: 62_310,
      inputTokens: 4_812_000,
      cachedInputTokens: 1_200_000,
      outputTokens: 918_000,
      apiRunCount: 41,
      subscriptionRunCount: 3,
      subscriptionCachedInputTokens: 0,
      subscriptionInputTokens: 0,
      subscriptionOutputTokens: 0,
    },
    {
      agentId: "33333333-3333-4333-8333-333333333333",
      agentName: "agent-b",
      agentStatus: "active",
      costCents: 31_120,
      inputTokens: 2_010_000,
      cachedInputTokens: 640_000,
      outputTokens: 512_000,
      apiRunCount: 28,
      subscriptionRunCount: 0,
      subscriptionCachedInputTokens: 0,
      subscriptionInputTokens: 0,
      subscriptionOutputTokens: 0,
    },
  ],
  budgetsOverview: {
    companyId: COMPANY_ID,
    policies: [
      {
        policyId: "p1",
        companyId: COMPANY_ID,
        scopeType: "company",
        scopeId: COMPANY_ID,
        scopeName: "company-a",
        metric: "billed_cents",
        windowKind: "calendar_month_utc",
        amount: 220_000,
        observedAmount: 157_400,
        remainingAmount: 62_600,
        utilizationPercent: 71.5,
        warnPercent: 80,
        hardStopEnabled: false,
        notifyEnabled: true,
        isActive: true,
        status: "ok",
        paused: false,
        pauseReason: null,
        windowStart: minutesAgo(120 * 24 * 30),
        windowEnd: minutesAgo(-60),
      },
      {
        policyId: "p2",
        companyId: COMPANY_ID,
        scopeType: "agent",
        scopeId: AGENT_ID,
        scopeName: "agent-a",
        metric: "billed_cents",
        windowKind: "calendar_month_utc",
        amount: 80_000,
        observedAmount: 62_310,
        remainingAmount: 17_690,
        utilizationPercent: 77.9,
        warnPercent: 70,
        hardStopEnabled: false,
        notifyEnabled: true,
        isActive: true,
        status: "warning",
        paused: false,
        pauseReason: null,
        windowStart: minutesAgo(120 * 24 * 30),
        windowEnd: minutesAgo(-60),
      },
    ],
    activeIncidents: [
      {
        id: "i1",
        companyId: COMPANY_ID,
        policyId: "p3",
        scopeType: "project",
        scopeId: "proj-1",
        scopeName: "ui2",
        metric: "billed_cents",
        windowKind: "calendar_month_utc",
        windowStart: minutesAgo(120 * 24 * 30),
        windowEnd: minutesAgo(-60),
        thresholdType: "warn",
        amountLimit: 40_000,
        amountObserved: 48_200,
        status: "open",
        approvalId: null,
        approvalStatus: null,
        resolvedAt: null,
        createdAt: minutesAgo(90),
        updatedAt: minutesAgo(90),
      },
    ],
    pausedAgentCount: 0,
    pausedProjectCount: 1,
    pendingApprovalCount: 0,
  },
  members: {
    members: [
      {
        id: "m1",
        companyId: COMPANY_ID,
        principalType: "user",
        principalId: "u1",
        status: "active",
        membershipRole: "owner",
        createdAt: minutesAgo(60 * 24 * 30),
        updatedAt: minutesAgo(60),
        user: { id: "u1", email: "owner@example.com", name: "Alex", image: null },
        grants: [],
      },
      {
        id: "m2",
        companyId: COMPANY_ID,
        principalType: "user",
        principalId: "u2",
        status: "pending",
        membershipRole: "operator",
        createdAt: minutesAgo(60 * 24),
        updatedAt: minutesAgo(60 * 24),
        user: { id: "u2", email: "op@example.com", name: "Sam", image: null },
        grants: [],
      },
    ],
    access: {
      currentUserRole: "owner",
      canManageMembers: true,
      canInviteUsers: true,
      canApproveJoinRequests: true,
    },
  },
  boardApiKeys: [
    {
      id: "k1",
      name: "Telegram gateway",
      scope: { kind: "telegram_gateway" },
      createdAt: minutesAgo(60 * 24 * 12),
      lastUsedAt: minutesAgo(4),
      revokedAt: null,
      expiresAt: null,
    },
    {
      id: "k2",
      name: "Grafana",
      scope: { kind: "grafana" },
      createdAt: minutesAgo(60 * 24 * 40),
      lastUsedAt: null,
      revokedAt: minutesAgo(60 * 24),
      expiresAt: minutesAgo(-60 * 24 * 20),
    },
  ],
  activity: Array.from({ length: 6 }, (_, index) => ({
    id: `a${index}`,
    companyId: COMPANY_ID,
    actorType: "agent",
    actorId: AGENT_ID,
    action: index % 2 === 0 ? "agent.budget_updated" : "issue.status_changed",
    entityType: "agent",
    entityId: AGENT_ID,
    agentId: AGENT_ID,
    runId: null,
    responsibleUserId: null,
    details: null,
    createdAt: minutesAgo(30 * (index + 1)),
  })),
  runtimeLimits: {
    limits: {
      maxConcurrentRuns: 24,
      maxStartsPerMinute: 12,
      minFreeMemoryMb: null,
      runMemoryEstimateMb: 1536,
    },
    sources: {
      maxConcurrentRuns: "settings",
      maxStartsPerMinute: "settings",
      minFreeMemoryMb: "env",
      runMemoryEstimateMb: "default",
    },
  },
};

/**
 * Story-level fetch mock for the ui2 screen endpoints. Chained BEFORE the
 * preview-level storybook fixtures: unknown paths fall through to them
 * (auth session, company list, …), so the company selection works.
 */
function installUi2FetchFixtures() {
  const currentWindow = window as typeof window & {
    __ui2StorybookFetchInstalled?: boolean;
  };
  if (currentWindow.__ui2StorybookFetchInstalled) return;
  currentWindow.__ui2StorybookFetchInstalled = true;

  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(rawUrl, window.location.origin);
    const path = url.pathname.replace(/^\/api/, "");
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

    if (path.startsWith(`/companies/${COMPANY_ID}/decisions`)) return json(fixtures.decisions);
    if (path === `/companies/${COMPANY_ID}/agents`) return json(fixtures.agents);
    if (path === `/companies/${COMPANY_ID}/costs/summary`) return json(fixtures.costSummary);
    if (path === `/companies/${COMPANY_ID}/costs/by-agent`) return json(fixtures.byAgent);
    if (path === `/companies/${COMPANY_ID}/budgets/overview`) return json(fixtures.budgetsOverview);
    if (path === `/companies/${COMPANY_ID}/members`) return json(fixtures.members);
    if (path === "/board-api-keys") return json(fixtures.boardApiKeys);
    if (path === `/companies/${COMPANY_ID}/activity`) return json(fixtures.activity);
    if (path === "/myrmidon/runtime-limits") return json(fixtures.runtimeLimits);
    return originalFetch(input, init);
  };
}

const meta = {
  title: "Myrmidon UI 2.0",
  decorators: [
    (Story, context) => {
      installUi2FetchFixtures();
      const locale = (context.parameters.ui2?.locale ?? "en") as Ui2Locale;
      return (
        <Ui2I18nProvider initialLocale={locale}>
          <Story />
        </Ui2I18nProvider>
      );
    },
  ],
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const Decisions: Story = {
  render: () => <Ui2Decisions />,
};

export const DecisionsRussian: Story = {
  parameters: { ui2: { locale: "ru" } },
  render: () => <Ui2Decisions />,
};

export const Costs: Story = {
  render: () => <Ui2Costs />,
};

export const CostsRussian: Story = {
  parameters: { ui2: { locale: "ru" } },
  render: () => <Ui2Costs />,
};

const runFixture = (index: number) =>
  ({
    id: `run-${index}`,
    companyId: COMPANY_ID,
    agentId: AGENT_ID,
    invocationSource: "wakeup",
    triggerDetail: null,
    status: index === 0 ? "running" : index === 1 ? "succeeded" : "failed",
    responsibleUserId: null,
    startedAt: minutesAgo(index * 40 + 5),
    finishedAt: index === 0 ? null : minutesAgo(index * 40),
    error: index === 2 ? "exit 1" : null,
    wakeupRequestId: null,
    exitCode: index === 2 ? 1 : 0,
    signal: null,
    usageJson: {
      inputTokens: 120_000 - index * 1000,
      outputTokens: 24_000 - index * 500,
      costUsd: 0.4321 - index * 0.05,
    },
    resultJson: null,
    sessionIdBefore: null,
    sessionIdAfter: null,
    logStore: null,
    logRef: null,
    createdAt: minutesAgo(index * 40 + 6),
  }) as unknown as HeartbeatRun;

const agentRuns: HeartbeatRun[] = Array.from({ length: 3 }, (_, index) => runFixture(index));

export const AgentOverview: Story = {
  render: () => (
    <Ui2AgentOverview
      agent={agentFixture}
      agentId={AGENT_ID}
      companyId={COMPANY_ID}
      runs={agentRuns}
    />
  ),
};

export const AgentOverviewRussian: Story = {
  parameters: { ui2: { locale: "ru" } },
  render: () => (
    <Ui2AgentOverview
      agent={agentFixture}
      agentId={AGENT_ID}
      companyId={COMPANY_ID}
      runs={agentRuns}
    />
  ),
};

export const RunsSettings: Story = {
  render: () => <Ui2RunsSettings />,
};

export const RunsSettingsRussian: Story = {
  parameters: { ui2: { locale: "ru" } },
  render: () => <Ui2RunsSettings />,
};

export const SystemSettings: Story = {
  render: () => <Ui2SystemSettings />,
};

export const SystemSettingsRussian: Story = {
  parameters: { ui2: { locale: "ru" } },
  render: () => <Ui2SystemSettings />,
};

export const LanguageSettings: Story = {
  render: () => <Ui2LanguageSettings />,
};


export const LanguageSettingsRussian: Story = {
  parameters: { ui2: { locale: "ru" } },
  render: () => <Ui2LanguageSettings />,
};

// --- State artboards (operator's design decisions 02.10) -------------------
// Every screen ships its states as mocked-state stories: empty (done /
// filtered), skeleton loading, error with and without cache, denied (no
// partial numbers behind the lock). Each state story patches the SAME fetch
// fixture the happy-path stories install, so the visual suite screenshots
// the real component states — not a dedicated mock component.

type ResponseOverride = { status?: number; body?: unknown; hang?: boolean };

function stateResponsesDecorator(overrides: Record<string, ResponseOverride>) {
  return function StateResponsesDecorator(Story: () => React.ReactElement) {
    installUi2FetchFixtures();
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(rawUrl, window.location.origin);
      const path = url.pathname.replace(/^\/api/, "");
      const override = overrides[path];
      if (override) {
        if (override.hang) {
          return new Promise<Response>(() => undefined);
        }
        return new Response(JSON.stringify(override.body ?? {}), {
          status: override.status ?? 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return originalFetch(input, init);
    };
    return <Story />;
  };
}

const DECISIONS_PATH = `/companies/${COMPANY_ID}/decisions`;

export const DecisionsStateSkeleton: Story = {
  decorators: [stateResponsesDecorator({ [DECISIONS_PATH]: { hang: true } })],
  render: () => <Ui2Decisions />,
};

export const DecisionsStateEmptyDone: Story = {
  decorators: [stateResponsesDecorator({ [DECISIONS_PATH]: { body: [] } })],
  render: () => <Ui2Decisions />,
};

export const DecisionsStateEmptyFiltered: Story = {
  decorators: [
    stateResponsesDecorator({
      // All decisions are money-grouped; the "policies" filter therefore
      // shows the filtered-empty state.
      [DECISIONS_PATH]: {
        body: fixtures.decisions.map((decision) => ({ ...decision, ruleKey: "budget_raise" })),
      },
    }),
  ],
  render: () => <Ui2Decisions />,
};

export const DecisionsStateErrorNoCache: Story = {
  decorators: [stateResponsesDecorator({ [DECISIONS_PATH]: { status: 500, body: { error: "upstream timeout" } } })],
  render: () => <Ui2Decisions />,
};

export const CostsStateSkeleton: Story = {
  decorators: [
    stateResponsesDecorator({
      [`/companies/${COMPANY_ID}/costs/summary`]: { hang: true },
      [`/companies/${COMPANY_ID}/budgets/overview`]: { hang: true },
    }),
  ],
  render: () => <Ui2Costs />,
};

export const CostsStateErrorWithCache: Story = {
  decorators: [
    stateResponsesDecorator({
      // React Query keeps serving the cached list while the summary query
      // fails — the error note renders alongside the tiles.
      [`/companies/${COMPANY_ID}/costs/summary`]: { status: 500, body: { error: "summary unavailable" } },
    }),
  ],
  render: () => <Ui2Costs />,
};

export const CostsStateEmpty: Story = {
  decorators: [
    stateResponsesDecorator({
      [`/companies/${COMPANY_ID}/costs/summary`]: {
        body: { companyId: COMPANY_ID, spendCents: 0, budgetCents: 0, utilizationPercent: 0 },
      },
      [`/companies/${COMPANY_ID}/budgets/overview`]: {
        body: {
          companyId: COMPANY_ID,
          policies: [],
          activeIncidents: [],
          pausedAgentCount: 0,
          pausedProjectCount: 0,
          pendingApprovalCount: 0,
        },
      },
      [`/companies/${COMPANY_ID}/costs/by-agent`]: { body: [] },
    }),
  ],
  render: () => <Ui2Costs />,
};

export const SystemSettingsStateSkeleton: Story = {
  decorators: [
    stateResponsesDecorator({
      [`/companies/${COMPANY_ID}/members`]: { hang: true },
    }),
  ],
  render: () => <Ui2SystemSettings />,
};

export const SystemSettingsStateEmpty: Story = {
  decorators: [
    stateResponsesDecorator({
      [`/companies/${COMPANY_ID}/members`]: { body: { members: [], access: fixtures.members.access } },
      "/board-api-keys": { body: [] },
      [`/companies/${COMPANY_ID}/activity`]: { body: [] },
    }),
  ],
  render: () => <Ui2SystemSettings />,
};

export const RunsSettingsStateSkeleton: Story = {
  decorators: [stateResponsesDecorator({ "/myrmidon/runtime-limits": { hang: true } })],
  render: () => <Ui2RunsSettings />,
};

export const RunsSettingsStateError: Story = {
  decorators: [stateResponsesDecorator({ "/myrmidon/runtime-limits": { status: 503, body: { error: "limits service down" } } })],
  render: () => <Ui2RunsSettings />,
};

// The denied state: a screen whose endpoint answers 403. The operator rule —
// no partial numbers behind the lock — is exercised by the guard test, and
// this story pins the visual: the lock card alone.
export const SystemSettingsStateDenied: Story = {
  decorators: [
    stateResponsesDecorator({
      [`/companies/${COMPANY_ID}/members`]: { status: 403, body: { error: "forbidden" } },
    }),
  ],
  render: () => <Ui2SystemSettings />,
};
