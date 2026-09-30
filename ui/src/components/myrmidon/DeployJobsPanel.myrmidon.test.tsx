// @vitest-environment jsdom

// myrmidon(R5-A) deploy jobs: the update panel.
//
// Pins the operator's flow: a non-digest reference is refused in the field
// itself; the preview shows the CI verdict (and a refusal as a refusal); the
// deploy button waits for a confirmation; an active job is shown with its
// steps and offers the abort only while it is abortable.

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeployJobsPanelView } from "./DeployJobsPanel";
import { digestProblemClient, describeDeployStatus, type DeployJobState, type DeployJobView } from "./deployJobsApi";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
});

const NOW = "2026-09-30T08:00:00.000Z";

function job(overrides: Partial<DeployJobView> = {}): DeployJobView {
  return {
    id: "job-a",
    digest: `sha256:${"b".repeat(64)}`,
    version: "1.2.1",
    commit: "0123456789abcdef0123456789abcdef01234567",
    status: "maintenance_entering",
    reason: "deploy",
    startedBy: { actorType: "user", actorId: "user-a" },
    createdAt: NOW,
    updatedAt: NOW,
    verifiedAt: NOW,
    healthVersion: null,
    healthCommit: null,
    failureReason: null,
    steps: [{ at: NOW, status: "pending", detail: "job created" }],
    active: true,
    abortable: true,
    ...overrides,
  };
}

function render(props: Partial<Parameters<typeof DeployJobsPanelView>[0]> = {}) {
  flushSync(() =>
    root.render(
      <DeployJobsPanelView
        state={{ job: null, history: [] } as DeployJobState}
        preview={null}
        onPreview={() => undefined}
        onStart={() => undefined}
        onAbort={() => undefined}
        pending={false}
        error={null}
        {...props}
      />,
    ),
  );
  return container.querySelector('[data-testid="myrmidon-deploy-jobs"]');
}

describe("DeployJobsPanel", () => {
  it("shows an empty state when no deploy has run", () => {
    const panel = render();
    expect(panel).not.toBeNull();
    expect(panel!.textContent).toContain("No deploy has run yet");
  });

  it("shows the live job with its status and steps, and the abort while abortable", () => {
    const panel = render({ state: { job: job(), history: [] } });
    expect(panel!.textContent).toContain("Waiting for the maintenance window to drain");
    expect(panel!.textContent).toContain("job created");
    expect(panel!.textContent).toContain("Abort");
  });

  it("hides the abort once the switch started", () => {
    const panel = render({ state: { job: job({ status: "running", abortable: false }), history: [] } });
    expect(panel!.textContent).toContain("Switching the image");
    expect(panel!.textContent).not.toContain("Abort");
  });

  it("shows the failure reason of a refused image", () => {
    const panel = render({
      state: {
        job: job({ status: "failed_verification", active: false, abortable: false, failureReason: "digest is not sha256" }),
        history: [],
      },
    });
    expect(panel!.textContent).toContain("Image refused");
    expect(panel!.textContent).toContain("digest is not sha256");
  });

  it("shows the preview verdict: ok and refused", () => {
    const ok = render({ preview: { ok: true, digest: `sha256:${"b".repeat(64)}`, version: "1.2.1", commit: "0123456789abcdef", reason: null } });
    expect(ok!.querySelector('[data-testid="myrmidon-deploy-preview-ok"]')).not.toBeNull();
    expect(ok!.textContent).toContain("CI image verified");

    const refused = render({ preview: { ok: false, digest: null, version: null, commit: null, reason: "not in the registry" } });
    expect(refused!.querySelector('[data-testid="myrmidon-deploy-preview-failed"]')).not.toBeNull();
    expect(refused!.textContent).toContain("Refused: not in the registry");
  });

  it("shows the operator error (for example: the feature is not enabled)", () => {
    const panel = render({ error: "deploys from the interface are not enabled" });
    expect(panel!.querySelector('[data-testid="myrmidon-deploy-error"]')?.textContent).toContain("not enabled");
  });

  it("lists previous deploys from history", () => {
    const panel = render({
      state: { job: null, history: [job({ status: "succeeded", active: false, abortable: false, id: "job-old" })] },
    });
    expect(panel!.textContent).toContain("Previous deploys (1)");
    expect(panel!.textContent).toContain("Deployed");
  });
});

describe("digestProblemClient", () => {
  const GOOD = `sha256:${"a".repeat(64)}`;
  it("accepts a bare digest and the full CI reference", () => {
    expect(digestProblemClient(GOOD)).toBeNull();
    expect(digestProblemClient(`ghcr.io/itkadr-git/myrmidon@${GOOD}`)).toBeNull();
  });
  it("refuses a tag, a foreign repository and a short digest", () => {
    expect(digestProblemClient("1.2.1")).toContain("tag");
    expect(digestProblemClient(`ghcr.io/other/repo@${GOOD}`)).toContain("Only images");
    expect(digestProblemClient("sha256:abc")).toContain("64 lowercase hex");
    expect(digestProblemClient("")).toContain("Enter the digest");
  });
});

describe("describeDeployStatus", () => {
  it("maps every status to an operator-readable line", () => {
    expect(describeDeployStatus("maintenance_on")).toContain("Maintenance on");
    expect(describeDeployStatus("succeeded")).toBe("Deployed");
    expect(describeDeployStatus("failed_health")).toBe("Health check failed");
  });
});

