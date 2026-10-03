// myrmidon(1.6-TG-PROACTIVITY-E): unit coverage for the proactivity gate —
// the decision core of part E (TG-NOTIFY-SETTINGS, 1.6.1). No database here:
// the pure `decideProactivity` core over the three modes, the rarely
// boundary, and the owner-driven lane recognition. The durable behaviors
// (counter persistence, day boundary, U2 bundling) are covered by the
// embedded-postgres suite in
// server/src/__tests__/telegram-notify-proactivity.myrmidon.test.ts.
//
// Neutral data only.

import { describe, expect, it } from "vitest";
import { DEFAULT_TELEGRAM_NOTIFY_PROACTIVITY_RARELY_MAX_PER_DAY } from "@paperclipai/shared";
import {
  decideProactivity,
  isOwnerDrivenPublicationKey,
  telegramNotifyDayBucket,
  type ProactivityGateInput,
} from "./proactivity-policy.js";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";

function candidate(
  overrides: Partial<ProactivityGateInput> = {},
): ProactivityGateInput {
  return {
    agentId: AGENT_ID,
    idempotencyKey: "comment:2222:3333",
    isReplyToOwner: false,
    ...overrides,
  };
}

describe("decideProactivity", () => {
  it("default mode blocks every proactive publication", () => {
    expect(
      decideProactivity({
        mode: "only_on_owner_request",
        sentToday: 0,
        rarelyMaxPerDay: 3,
        candidate: candidate(),
      }),
    ).toEqual({ outcome: "block" });
  });

  it("normal mode allows proactive publications without a limit", () => {
    for (const sentToday of [0, 3, 100]) {
      expect(
        decideProactivity({
          mode: "normal",
          sentToday,
          rarelyMaxPerDay: 3,
          candidate: candidate(),
        }),
      ).toEqual({ outcome: "allow" });
    }
  });

  it("rarely allows while under the ceiling and bundles past it", () => {
    expect(
      decideProactivity({
        mode: "rarely",
        sentToday: 0,
        rarelyMaxPerDay: 3,
        candidate: candidate(),
      }),
    ).toEqual({ outcome: "allow" });
    expect(
      decideProactivity({
        mode: "rarely",
        sentToday: 2,
        rarelyMaxPerDay: 3,
        candidate: candidate(),
      }),
    ).toEqual({ outcome: "allow" });
    // The N+1st proactive message of the day is not sent — it is bundled.
    expect(
      decideProactivity({
        mode: "rarely",
        sentToday: 3,
        rarelyMaxPerDay: 3,
        candidate: candidate(),
      }),
    ).toEqual({ outcome: "bundle" });
  });

  it("a reply to an owner message is allowed in every mode", () => {
    for (const mode of ["only_on_owner_request", "rarely", "normal"] as const) {
      expect(
        decideProactivity({
          mode,
          sentToday: 99,
          rarelyMaxPerDay: 3,
          candidate: candidate({ isReplyToOwner: true }),
        }),
      ).toEqual({ outcome: "allow" });
    }
  });

  it("U2 decision cards and command/status lanes are recognized as owner-driven", () => {
    for (const key of [
      "interaction:4444:5555",
      "run:6666:dmstatus:5555",
      "control:x8-new:7777",
      "explicit:8888",
    ]) {
      expect(isOwnerDrivenPublicationKey(key)).toBe(true);
      expect(
        decideProactivity({
          mode: "only_on_owner_request",
          sentToday: 99,
          rarelyMaxPerDay: 3,
          candidate: candidate({ idempotencyKey: key }),
        }),
      ).toEqual({ outcome: "allow" });
    }
    expect(isOwnerDrivenPublicationKey("comment:2222:3333")).toBe(false);
  });

  it("a missing agent id in rarely mode bundles instead of allowing", () => {
    expect(
      decideProactivity({
        mode: "rarely",
        sentToday: 0,
        rarelyMaxPerDay: 3,
        candidate: candidate({ agentId: null }),
      }),
    ).toEqual({ outcome: "bundle" });
  });
});

describe("day bucket", () => {
  it("is the UTC calendar day", () => {
    expect(telegramNotifyDayBucket(new Date("2026-10-03T23:59:59Z"))).toBe(
      "2026-10-03",
    );
    expect(telegramNotifyDayBucket(new Date("2026-10-04T00:00:00Z"))).toBe(
      "2026-10-04",
    );
  });
});

describe("default ceiling", () => {
  it("is the contract default of 3", () => {
    expect(
      DEFAULT_TELEGRAM_NOTIFY_PROACTIVITY_RARELY_MAX_PER_DAY,
    ).toBe(3);
  });
});