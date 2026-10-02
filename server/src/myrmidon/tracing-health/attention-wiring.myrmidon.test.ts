// myrmidon(TRACING-HEALTH) wiring tests: the attention generator block in
// vendor services/attention.ts and the decision-queue case in
// decision-queues.ts. The guard recipe is source scanning, not live imports:
// attention.ts pulls the whole db/services graph which a fake test cannot
// assemble (the app-wiring pattern of the tracing-health routes). The guard
// reds when the generator block or the queue case is missing — run it after
// `git stash push -- server/src/services/attention.ts
// server/src/services/decision-queues.ts packages/shared/src/types/attention.ts`
// to see it fail, then `git stash pop` for the green side.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (relative: string) => readFileSync(resolve(__dirname, relative), "utf8");

describe("tracing health attention wiring", () => {
  it("the shared attention contract registers the tracing_health source kind exactly once", () => {
    const shared = read("../../../../packages/shared/src/types/attention.ts");
    expect(shared.match(/"tracing_health"/g)).toEqual(["\"tracing_health\""]);
  });

  it("the attention service imports the generator and runs it behind the TRACING-HEALTH marker", () => {
    const source = read("../../services/attention.ts");
    expect(source).toContain("myrmidon(TRACING-HEALTH): LLM tracing degraded signal");
    expect(source).toContain("tracingHealthAttentionItems");
    expect(source).toContain("tracingHealthProbe");
    // The generator runs inside list(): the call site feeds the collected
    // items before dedup, so the dedup semantics ride the standard path.
    expect(source).toContain("for (const item of tracingHealthAttentionItems(tracingReport, companyId))");
  });

  it("the decision queues treat tracing_health as a board-only computed source", () => {
    const source = read("../../services/decision-queues.ts");
    expect(source).toContain("case \"tracing_health\"");
    expect(source).toContain("myrmidon(TRACING-HEALTH)");
  });

  it("the tracing generator emits board-only cards: no agent, no issue ownership", () => {
    const source = read("./attention.ts");
    expect(source).toContain("TRACING_HEALTH_SOURCE_KIND = \"tracing_health\"");
    expect(source).toContain("assertBoard");
    expect(source).not.toContain("assigneeAgentId");
  });
});
