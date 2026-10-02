import { describe, expect, it } from "vitest";
import { createConfirmationPort, createConfirmationRegistry, type ConfirmationUi } from "../src/confirmation";

function fakeUi(): { ui: ConfirmationUi; opened: unknown[]; closed: Array<string | number> } {
  const opened: unknown[] = [];
  const closed: Array<string | number> = [];
  return {
    ui: {
      open: (prompt) => opened.push(prompt),
      close: (requestId) => closed.push(requestId),
    },
    opened,
    closed,
  };
}

describe("confirmation registry", () => {
  it("settles a pending request when the person answers", async () => {
    const registry = createConfirmationRegistry();
    const answer = registry.request({ method: "browser.click", summary: "click", requestId: "gw-1" });
    expect(registry.pendingKeys()).toEqual(["gw-1"]);
    expect(registry.settle("gw-1", "confirmed")).toBe(true);
    await expect(answer).resolves.toBe("confirmed");
    expect(registry.pendingCount()).toBe(0);
  });

  it("answers a cancelled request as refused", async () => {
    const registry = createConfirmationRegistry();
    const answer = registry.request({ method: "browser.click", summary: "click", requestId: "gw-2" });
    expect(registry.cancel("gw-2")).toBe(true);
    await expect(answer).resolves.toBe("refused");
  });

  it("ignores an answer or cancellation for a request that is not pending", () => {
    const registry = createConfirmationRegistry();
    expect(registry.settle("nope", "confirmed")).toBe(false);
    expect(registry.cancel("nope")).toBe(false);
  });

  it("keys a request without a gateway id by a local sequence", async () => {
    const registry = createConfirmationRegistry();
    const answer = registry.request({ method: "browser.click", summary: "click" });
    expect(registry.pendingKeys()).toEqual(["local-1"]);
    registry.settle("local-1", "refused");
    await expect(answer).resolves.toBe("refused");
  });
});

describe("confirmation port", () => {
  it("opens the prompt for a request and answers it on cancellation", async () => {
    const registry = createConfirmationRegistry();
    const { ui, opened, closed } = fakeUi();
    const port = createConfirmationPort(registry, ui);
    const answer = port.request({ method: "browser.click", summary: "click", requestId: "gw-3" });
    expect(opened).toEqual([{ method: "browser.click", summary: "click", requestId: "gw-3" }]);
    port.cancel("gw-3");
    await expect(answer).resolves.toBe("refused");
    expect(closed).toEqual(["gw-3"]);
  });
});