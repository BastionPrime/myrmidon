// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  AgentCardContainerFields,
  AgentCardContainerFieldsView,
  applyBlockedReason,
  type AgentCardContainerFieldsViewProps,
} from "./AgentCardContainerFields";
import {
  botContainerApi,
  describeApplyError,
  describeApplyOutcome,
  type BotContainerStatus,
} from "./botContainerApi";
import {
  BOT_CONTAINER_DEFAULTS,
  botContainerProblems,
  disableBotContainer,
  enableBotContainer,
  parseBotContainerNumber,
  readBotContainerCard,
  setBotContainerNumber,
  setBotContainerText,
} from "./botContainerConfig";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

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

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

function byId(id: string) {
  return container.querySelector(`[data-testid="myrmidon-bot-container-${id}"]`) as HTMLElement | null;
}

function text(id: string) {
  return byId(id)?.textContent ?? null;
}

function setText(input: HTMLElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function click(element: HTMLElement | null | undefined) {
  act(() => element!.click());
}

function sectionHeader() {
  return [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Container")!;
}

function renderView(overrides: Partial<AgentCardContainerFieldsViewProps> = {}) {
  const onChange = vi.fn();
  const onApply = vi.fn();
  const onRefresh = vi.fn();
  const props: AgentCardContainerFieldsViewProps = {
    value: CARD,
    onChange,
    unsaved: false,
    status: STATUS,
    statusError: null,
    applying: false,
    feedback: null,
    onApply,
    onRefresh,
    ...overrides,
  };
  act(() =>
    root.render(
      <TooltipProvider>
        <AgentCardContainerFieldsView {...props} />
      </TooltipProvider>,
    ),
  );
  return { onChange, onApply, onRefresh };
}

async function flush() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe("myrmidon(W2b) container card logic", () => {
  it("accepts plain numbers inside the ranges and nothing else", () => {
    expect(parseBotContainerNumber("memoryMb", "2048")).toEqual({ ok: true, value: 2048 });
    expect(parseBotContainerNumber("memoryMb", " 4096 ")).toEqual({ ok: true, value: 4096 });
    for (const bad of ["", "abc", "12", "2048.5", "1e3", "-2048", "+2048", "262145", "2 048"]) {
      expect(parseBotContainerNumber("memoryMb", bad).ok, `memoryMb ${JSON.stringify(bad)}`).toBe(false);
    }
    expect(parseBotContainerNumber("cpus", "0.5")).toEqual({ ok: true, value: 0.5 });
    expect(parseBotContainerNumber("cpus", "1.25")).toEqual({ ok: true, value: 1.25 });
    expect(parseBotContainerNumber("cpus", "2")).toEqual({ ok: true, value: 2 });
    for (const bad of ["0", "0.05", "1.255", "129", "1,5", ".5", "1."]) {
      expect(parseBotContainerNumber("cpus", bad).ok, `cpus ${JSON.stringify(bad)}`).toBe(false);
    }
    expect(parseBotContainerNumber("pidsLimit", "512")).toEqual({ ok: true, value: 512 });
    for (const bad of ["15", "1.5", "65537", "0"]) {
      expect(parseBotContainerNumber("pidsLimit", bad).ok, `pidsLimit ${JSON.stringify(bad)}`).toBe(false);
    }
    expect(parseBotContainerNumber("memoryMb", "12")).toMatchObject({
      ok: false,
      message: "Enter a whole number from 128 to 262144.",
    });
  });

  it("turning the section on writes explicit defaults and keeps values already set", () => {
    expect(enableBotContainer({})).toEqual({ enabled: true, ...BOT_CONTAINER_DEFAULTS });
    expect(BOT_CONTAINER_DEFAULTS).toEqual({ memoryMb: 2048, cpus: 1, pidsLimit: 512 });
    expect(enableBotContainer({ image: "x:1", memoryMb: 4096, enabled: false, extra: "kept" })).toEqual({
      enabled: true,
      image: "x:1",
      memoryMb: 4096,
      cpus: 1,
      pidsLimit: 512,
      extra: "kept",
    });
  });

  it("turning it off keeps the settings; an untouched card stays untouched", () => {
    expect(disableBotContainer(CARD)).toEqual({ ...CARD, enabled: false });
    expect(disableBotContainer({})).toBeUndefined();
  });

  it("an empty text field removes its key, so an empty group never reaches the server", () => {
    expect(setBotContainerText(CARD, "image", "  x:2  ")).toMatchObject({ image: "x:2" });
    const cleared = setBotContainerText({ ...CARD, group: "g" }, "group", "   ");
    expect("group" in cleared).toBe(false);
    expect("image" in setBotContainerText(CARD, "image", "")).toBe(false);
    expect(setBotContainerNumber(CARD, "cpus", 2)).toEqual({ ...CARD, cpus: 2 });
  });

  it("reads anything that is not a plain object as an empty card", () => {
    expect(readBotContainerCard(undefined)).toEqual({});
    expect(readBotContainerCard(null)).toEqual({});
    expect(readBotContainerCard([1])).toEqual({});
    expect(readBotContainerCard("x")).toEqual({});
    expect(readBotContainerCard(CARD)).toBe(CARD);
  });

  it("lists what is wrong with an enabled card and nothing for a complete or disabled one", () => {
    expect(botContainerProblems(CARD)).toEqual([]);
    expect(botContainerProblems({ enabled: false })).toEqual([]);
    expect(botContainerProblems({ enabled: true })).toEqual([
      "Image is required.",
      "Memory must be a whole number from 128 to 262144.",
      "CPU must be a number from 0.1 to 128 (up to 2 decimals).",
      "Process limit must be a whole number from 16 to 65536.",
    ]);
    expect(botContainerProblems({ ...CARD, memoryMb: "2048" })).toEqual([
      "Memory must be a whole number from 128 to 262144.",
    ]);
    expect(botContainerProblems({ ...CARD, group: "shared" })).toEqual([
      "Shared containers (Group) are not supported yet: leave Group empty.",
    ]);
  });
});

describe("myrmidon(W2b) container card section", () => {
  it("stays collapsed for a card without the section, and opens to an off switch", () => {
    renderView({ value: undefined, status: null });
    expect(container.textContent).toContain("Container");
    expect(byId("enabled")).toBeNull();
    click(sectionHeader());
    expect(byId("enabled")?.getAttribute("aria-checked")).toBe("false");
    expect(byId("image")).toBeNull();
    expect(byId("memoryMb")).toBeNull();
  });

  it("turning it on writes the defaults", () => {
    const { onChange } = renderView({ value: undefined });
    click(sectionHeader());
    click(byId("enabled"));
    expect(onChange).toHaveBeenCalledWith({ enabled: true, memoryMb: 2048, cpus: 1, pidsLimit: 512 });
  });

  it("turning it off keeps the settings and hides the fields", () => {
    const { onChange } = renderView();
    expect(byId("enabled")?.getAttribute("aria-checked")).toBe("true");
    click(byId("enabled"));
    expect(onChange).toHaveBeenCalledWith({ ...CARD, enabled: false });
    renderView({ value: { ...CARD, enabled: false } });
    expect(byId("enabled")?.getAttribute("aria-checked")).toBe("false");
    expect(byId("image")).toBeNull();
    expect(byId("problems")).toBeNull();
  });

  it("shows the saved values in the fields", () => {
    renderView();
    expect((byId("image") as HTMLInputElement).value).toBe("bot-image:1");
    expect((byId("memoryMb") as HTMLInputElement).value).toBe("2048");
    expect((byId("cpus") as HTMLInputElement).value).toBe("1");
    expect((byId("pidsLimit") as HTMLInputElement).value).toBe("512");
    expect((byId("group") as HTMLInputElement).value).toBe("");
  });

  it("stores the image trimmed and drops the key when it is cleared", () => {
    const { onChange } = renderView();
    setText(byId("image")!, " bot-image:2 ");
    expect(onChange).toHaveBeenLastCalledWith({ ...CARD, image: "bot-image:2" });
    setText(byId("image")!, "");
    const cleared = onChange.mock.calls.at(-1)![0] as Record<string, unknown>;
    expect("image" in cleared).toBe(false);
    expect(cleared.memoryMb).toBe(2048);
  });

  it("validates the numbers: a valid entry is stored, an invalid one is flagged and not stored", () => {
    const { onChange } = renderView();

    setText(byId("memoryMb")!, "abc");
    expect(text("memoryMb-error")).toBe("Enter a whole number from 128 to 262144.");
    expect(byId("memoryMb")?.getAttribute("aria-invalid")).toBe("true");
    setText(byId("memoryMb")!, "64");
    expect(text("memoryMb-error")).toContain("128");
    expect(onChange).not.toHaveBeenCalled();

    setText(byId("memoryMb")!, "4096");
    expect(byId("memoryMb-error")).toBeNull();
    expect(onChange).toHaveBeenLastCalledWith({ ...CARD, memoryMb: 4096 });

    setText(byId("cpus")!, "1.255");
    expect(text("cpus-error")).toBe("Enter a number from 0.1 to 128 (up to 2 decimals).");
    setText(byId("cpus")!, "0.5");
    expect(onChange).toHaveBeenLastCalledWith({ ...CARD, cpus: 0.5 });

    setText(byId("pidsLimit")!, "1.5");
    expect(text("pidsLimit-error")).toBe("Enter a whole number from 16 to 65536.");
    setText(byId("pidsLimit")!, "1024");
    expect(onChange).toHaveBeenLastCalledWith({ ...CARD, pidsLimit: 1024 });
  });

  it("flags an out-of-range number that was stored by hand", () => {
    renderView({ value: { ...CARD, memoryMb: 12 } });
    expect(text("memoryMb-error")).toContain("128");
    expect(text("problems")).toContain("Memory must be a whole number");
  });

  it("warns about a group and stores nothing for an empty one", () => {
    const { onChange } = renderView();
    expect(byId("group-warning")).toBeNull();
    setText(byId("group")!, "shared-a");
    expect(onChange).toHaveBeenLastCalledWith({ ...CARD, group: "shared-a" });

    const second = renderView({ value: { ...CARD, group: "shared-a" } });
    expect(text("group-warning")).toContain("not supported yet");
    expect(text("problems")).toContain("leave Group empty");
    setText(byId("group")!, "");
    const cleared = second.onChange.mock.calls.at(-1)![0] as Record<string, unknown>;
    expect("group" in cleared).toBe(false);
  });

  it("asks for an image on an enabled card without one", () => {
    renderView({ value: { enabled: true, memoryMb: 2048, cpus: 1, pidsLimit: 512 } });
    expect(text("problems")).toContain("Image is required.");
  });

  it("hints the images the instance allows", () => {
    renderView();
    expect(text("allowlist")).toBe("Allowed on this instance: bot-image:*");
    renderView({ status: { ...STATUS, imageAllowlist: ["bot-image:*", "other/bot-image:1"] } });
    expect(text("allowlist")).toBe("Allowed on this instance: bot-image:*, other/bot-image:1");
    renderView({ status: { ...STATUS, imageAllowlist: [] } });
    expect(text("allowlist")).toBe("This instance allows no images yet, so nothing can be applied.");
    renderView({ status: null });
    expect(byId("allowlist")).toBeNull();
  });

  it("says when the saved image is not on the allowlist, but not while the image is being edited", () => {
    renderView({ status: { ...STATUS, imageAllowed: false } });
    expect(text("image-not-allowed")).toContain("not on the allowlist");
    renderView({ status: { ...STATUS, imageAllowed: false }, unsaved: true });
    expect(byId("image-not-allowed")).toBeNull();
    renderView({ status: { ...STATUS, imageAllowed: null } });
    expect(byId("image-not-allowed")).toBeNull();
  });

  it("describes the container status", () => {
    renderView();
    expect(text("status")).toBe("Running (bot-image:1)");
    renderView({ status: { ...STATUS, container: { state: "missing", image: null } } });
    expect(text("status")).toBe("Not created yet");
    renderView({ status: { ...STATUS, container: { state: "stopped", image: "bot-image:1" } } });
    expect(text("status")).toBe("Stopped (bot-image:1)");
    renderView({ status: { ...STATUS, container: { state: "unhealthy", image: null } } });
    expect(text("status")).toBe("Unhealthy");
    renderView({ status: { ...STATUS, enabled: false, container: null } });
    expect(text("status")).toContain("switched off on this instance");
    renderView({ status: { ...STATUS, runtimeConfigured: false, container: null } });
    expect(text("status")).toContain("No container runtime is configured");
    renderView({ status: { ...STATUS, container: null, containerError: "The container runtime did not answer." } });
    expect(text("status")).toBe("Container status unavailable: The container runtime did not answer.");
    renderView({ status: null, statusError: "Agent not found" });
    expect(text("status")).toBe("Container status unavailable: Agent not found");
    renderView({ status: null });
    expect(text("status")).toBe("Checking container status...");
  });

  it("refreshes the status on request", () => {
    const { onRefresh } = renderView();
    click(byId("refresh"));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});

describe("myrmidon(W2b) apply now", () => {
  const applyButton = () => byId("apply") as HTMLButtonElement;

  it("runs the apply when the saved card is ready", () => {
    const { onApply } = renderView();
    expect(applyButton().disabled).toBe(false);
    expect(byId("apply-hint")).toBeNull();
    click(applyButton());
    expect(onApply).toHaveBeenCalledTimes(1);
  });

  it("is off while the section has unsaved edits, and says why", () => {
    const { onApply } = renderView({ unsaved: true });
    expect(applyButton().disabled).toBe(true);
    expect(text("apply-hint")).toBe("Save the card first: Apply now uses the saved settings.");
    click(applyButton());
    expect(onApply).not.toHaveBeenCalled();
  });

  it("is off when the instance cannot apply, with the reason", () => {
    renderView({ status: { ...STATUS, enabled: false } });
    expect(applyButton().disabled).toBe(true);
    expect(text("apply-hint")).toBe("Bot containers are not enabled on this instance.");
    renderView({ status: { ...STATUS, runtimeConfigured: false } });
    expect(applyButton().disabled).toBe(true);
    expect(text("apply-hint")).toBe("The bot container runtime is not configured on this instance.");
    renderView({ status: { ...STATUS, eligible: false, reason: "container.image must be a non-empty string" } });
    expect(applyButton().disabled).toBe(true);
    expect(text("apply-hint")).toBe(
      "The saved card cannot be applied: container.image must be a non-empty string",
    );
    renderView({ status: null });
    expect(applyButton().disabled).toBe(true);
    renderView({ status: null, statusError: "boom" });
    expect(applyButton().disabled).toBe(true);
    expect(text("apply-hint")).toBe("Container status is unavailable.");
  });

  it("shows progress and the outcome", () => {
    renderView({ applying: true });
    expect(applyButton().disabled).toBe(true);
    expect(applyButton().textContent).toBe("Applying...");
    expect((byId("refresh") as HTMLButtonElement).disabled).toBe(true);

    renderView({ feedback: { kind: "ok", message: "Container created and started." } });
    expect(text("feedback")).toBe("Container created and started.");
    expect(byId("feedback")?.getAttribute("role")).toBe("status");
    renderView({ feedback: { kind: "error", message: "Apply failed: boom" } });
    expect(text("feedback")).toBe("Apply failed: boom");
  });

  it("names the reasons for the pure gate in one place", () => {
    expect(applyBlockedReason(STATUS, false, null)).toBeNull();
    expect(applyBlockedReason(STATUS, true, null)).toContain("Save the card first");
    expect(applyBlockedReason({ ...STATUS, eligible: false, reason: null }, false, null)).toBe(
      "The saved card cannot be applied: it is not a complete container config.",
    );
  });
});

describe("myrmidon(W2b) apply outcomes and errors", () => {
  it("words every outcome", () => {
    expect(describeApplyOutcome({ kind: "created" })).toEqual({ kind: "ok", message: "Container created and started." });
    expect(describeApplyOutcome({ kind: "applied_files" }).message).toBe("Profile files updated in the running container.");
    expect(describeApplyOutcome({ kind: "applied_restart" }).message).toBe("Profile updated and the gateway restarted.");
    expect(describeApplyOutcome({ kind: "unchanged" }).message).toBe(
      "Nothing to change: the container already matches the card.",
    );
    expect(describeApplyOutcome({ kind: "deferred", reason: "runs still active" })).toEqual({
      kind: "warn",
      message: "Not applied yet: runs still active",
    });
    expect(describeApplyOutcome({ kind: "error", message: "boom" })).toEqual({
      kind: "error",
      message: "Apply failed: boom",
    });
  });

  it("words the request failures", () => {
    expect(describeApplyError(new ApiError("x", 409, { code: "bot_containers_disabled" })).message).toBe(
      "Bot containers are not enabled on this instance.",
    );
    expect(describeApplyError(new ApiError("x", 503, { code: "bot_container_runtime_unavailable" })).message).toBe(
      "The bot container runtime is not configured on this instance.",
    );
    expect(describeApplyError(new ApiError("boom", 502, { outcome: { kind: "error", message: "boom" } })).message).toBe(
      "Apply failed: boom",
    );
    expect(describeApplyError(new ApiError("container.group is not supported yet", 409, { code: "bot_container_not_applicable" })).message).toBe(
      "container.group is not supported yet",
    );
    expect(describeApplyError(new ApiError("Board access required", 403, {})).message).toBe("Board access required");
    expect(describeApplyError(new Error("network down")).message).toBe("network down");
    expect(describeApplyError("weird").message).toBe("Apply failed.");
  });
});

describe("myrmidon(W2b) connected container section", () => {
  function renderConnected(overrides: { unsaved?: boolean; onChange?: () => void } = {}) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    act(() =>
      root.render(
        <QueryClientProvider client={client}>
          <TooltipProvider>
            <AgentCardContainerFields
              agentId="agent-a"
              value={CARD}
              savedValue={CARD}
              unsaved={overrides.unsaved ?? false}
              onChange={overrides.onChange ?? vi.fn()}
            />
          </TooltipProvider>
        </QueryClientProvider>,
      ),
    );
  }

  it("asks the server for the status of this agent and shows it", async () => {
    const status = vi.spyOn(botContainerApi, "status").mockResolvedValue(STATUS);
    renderConnected();
    expect(text("status")).toBe("Checking container status...");
    await flush();
    expect(status).toHaveBeenCalledWith("agent-a");
    expect(text("status")).toBe("Running (bot-image:1)");
  });

  it("shows a failed status request instead of hanging", async () => {
    vi.spyOn(botContainerApi, "status").mockRejectedValue(new ApiError("Agent not found", 404, {}));
    renderConnected();
    await flush();
    expect(text("status")).toBe("Container status unavailable: Agent not found");
    expect((byId("apply") as HTMLButtonElement).disabled).toBe(true);
  });

  it("applies the saved card, shows the outcome and asks for the status again", async () => {
    const status = vi.spyOn(botContainerApi, "status").mockResolvedValue(STATUS);
    const apply = vi.spyOn(botContainerApi, "apply").mockResolvedValue({ outcome: { kind: "applied_restart" } });
    renderConnected();
    await flush();
    expect(status).toHaveBeenCalledTimes(1);

    click(byId("apply"));
    await flush();
    expect(apply).toHaveBeenCalledWith("agent-a");
    expect(text("feedback")).toBe("Profile updated and the gateway restarted.");
    expect(status).toHaveBeenCalledTimes(2);
  });

  it("shows the server's refusal and still refreshes the status", async () => {
    const status = vi.spyOn(botContainerApi, "status").mockResolvedValue(STATUS);
    vi.spyOn(botContainerApi, "apply").mockRejectedValue(
      new ApiError("x", 503, { code: "bot_container_runtime_unavailable" }),
    );
    renderConnected();
    await flush();
    click(byId("apply"));
    await flush();
    expect(text("feedback")).toBe("The bot container runtime is not configured on this instance.");
    expect(status).toHaveBeenCalledTimes(2);
  });

  it("shows a reconcile failure with its message", async () => {
    vi.spyOn(botContainerApi, "status").mockResolvedValue(STATUS);
    vi.spyOn(botContainerApi, "apply").mockRejectedValue(
      new ApiError("image pull failed", 502, { error: "image pull failed", outcome: { kind: "error", message: "image pull failed" } }),
    );
    renderConnected();
    await flush();
    click(byId("apply"));
    await flush();
    expect(text("feedback")).toBe("Apply failed: image pull failed");
  });

  it("never calls apply while the card has unsaved edits", async () => {
    vi.spyOn(botContainerApi, "status").mockResolvedValue(STATUS);
    const apply = vi.spyOn(botContainerApi, "apply");
    renderConnected({ unsaved: true });
    await flush();
    expect((byId("apply") as HTMLButtonElement).disabled).toBe(true);
    click(byId("apply"));
    await flush();
    expect(apply).not.toHaveBeenCalled();
  });
});
