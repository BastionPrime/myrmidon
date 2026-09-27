// @vitest-environment jsdom

import type { AnchorHTMLAttributes, ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";

const issuesApiMock = vi.hoisted(() => ({
  resolveRecoveryAction: vi.fn(),
  update: vi.fn(),
}));

vi.mock("@/api/issues", () => ({ issuesApi: issuesApiMock }));
vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children?: ReactNode } & AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

import { ReplayBlockedChip, ReplayBlockedChipView, ReplayBlockedNotice } from "./ReplayBlocked";
import {
  describeResolveError,
  replayBlockedApi,
  submitReplayBlockedResolution,
  type ReplayBlockedIssue,
} from "./replayBlockedApi";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const EVIDENCE = "Provider process is stopped; the run's commit is not in the branch.";

function item(overrides: Partial<ReplayBlockedIssue> = {}): ReplayBlockedIssue {
  return {
    issueId: "issue-a",
    recoveryActionId: "22222222-2222-4222-8222-222222222222",
    runId: RUN_ID,
    runAgentId: "agent-a",
    assigneeAgentId: "agent-a",
    cause: "uncertain_provider_action",
    nextAction: "Automatic recovery stopped.",
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  issuesApiMock.resolveRecoveryAction.mockReset();
  issuesApiMock.update.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

function render(node: ReactNode) {
  act(() => root.render(node));
}

function withClient(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>;
}

async function flush() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function setValue(element: HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLSelectElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(element, value);
  element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
}

function button(label: string) {
  return [...container.querySelectorAll("button")].find((b) => b.textContent === label)!;
}

describe("replay-blocked chip", () => {
  it("renders only for a held task", () => {
    render(<ReplayBlockedChipView item={null} />);
    expect(container.textContent).toBe("");
    render(<ReplayBlockedChipView item={item()} />);
    expect(container.querySelector('[data-testid="myrmidon-replay-blocked-chip"]')?.textContent).toBe("Replay blocked");
  });

  it("renders nothing without a query client (rows rendered outside the app shell)", () => {
    render(<ReplayBlockedChip companyId="company-a" issueId="issue-a" />);
    expect(container.textContent).toBe("");
  });
});

describe("replay-blocked notice", () => {
  async function renderNotice(current: ReplayBlockedIssue) {
    vi.spyOn(replayBlockedApi, "list").mockResolvedValue({ issues: [current] });
    render(withClient(<ReplayBlockedNotice companyId="company-a" issueId={current.issueId} />));
    await flush();
  }

  it("shows the reason and the stopped run, and restores the task with a reconciliation", async () => {
    issuesApiMock.resolveRecoveryAction.mockResolvedValue({});
    await renderNotice(item());
    const notice = container.querySelector('[data-testid="myrmidon-replay-blocked-notice"]')!;
    expect(notice.textContent).toContain("Replay blocked");
    expect(notice.textContent).toContain("Automatic recovery stopped.");
    expect(notice.querySelector("a")?.getAttribute("href")).toBe(`/agents/agent-a/runs/${RUN_ID}`);

    act(() => button("Review and clear").click());
    const submit = button("Clear the block");
    act(() => setValue(container.querySelector("textarea")!, "too short"));
    expect(submit.disabled).toBe(true);

    act(() => setValue(container.querySelector("#myrmidon-replay-action-outcome") as HTMLSelectElement, "mixed"));
    act(() => setValue(container.querySelector("textarea")!, EVIDENCE));
    expect(submit.disabled).toBe(false);
    act(() => submit.click());
    await flush();

    expect(issuesApiMock.resolveRecoveryAction).toHaveBeenCalledWith("issue-a", {
      actionId: "22222222-2222-4222-8222-222222222222",
      outcome: "restored",
      sourceIssueStatus: "todo",
      resolutionNote: EVIDENCE,
      executionReconciliation: {
        runId: RUN_ID,
        providerStopped: true,
        actionOutcome: "mixed",
        outcomeEvidence: EVIDENCE,
      },
    });
    expect(issuesApiMock.update).not.toHaveBeenCalled();
  });

  it("explains an assignee mismatch when the server answers 409", async () => {
    issuesApiMock.resolveRecoveryAction.mockRejectedValue(
      new ApiError("The recovery source or task owner changed. Inspect the current execution before continuing.", 409, {}),
    );
    await renderNotice(item({ assigneeAgentId: "agent-b" }));
    act(() => button("Review and clear").click());
    act(() => setValue(container.querySelector("textarea")!, EVIDENCE));
    act(() => button("Clear the block").click());
    await flush();

    const error = container.querySelector('[data-testid="myrmidon-replay-blocked-error"]');
    expect(error?.textContent).toContain("Assign the task back to the run's agent");
  });
});

describe("resolution requests", () => {
  it("closes the task as done or cancelled with a status change and a comment", async () => {
    issuesApiMock.update.mockResolvedValue({});
    await submitReplayBlockedResolution(item(), { outcome: "done", actionOutcome: "not_performed", checked: " checked the branch " });
    await submitReplayBlockedResolution(item(), { outcome: "cancel", actionOutcome: "not_performed", checked: "no longer needed" });
    expect(issuesApiMock.update.mock.calls).toEqual([
      ["issue-a", { status: "done", comment: "Replay block reviewed and the task closed as done. Checked: checked the branch" }],
      ["issue-a", { status: "cancelled", comment: "Replay block reviewed and the task cancelled. Checked: no longer needed" }],
    ]);
    expect(issuesApiMock.resolveRecoveryAction).not.toHaveBeenCalled();
  });

  it("explains a 409 even when the assignee looks right, and passes other errors through", () => {
    const changed = new ApiError("The recovery source or task owner changed. Inspect the current execution before continuing.", 409, {});
    expect(describeResolveError(changed, item())).toContain("must be the run's agent");
    const running = new ApiError("The previous provider is still running. Stop it before continuing.", 409, {});
    expect(describeResolveError(running, item())).toContain("Stop it first");
    expect(describeResolveError(new ApiError("Board access required", 403, {}), item())).toBe("Board access required");
  });
});
