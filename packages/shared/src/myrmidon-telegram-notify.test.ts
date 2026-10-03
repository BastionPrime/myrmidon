// myrmidon(1.6-TG-PROACTIVITY-E): unit coverage for the proactivity policy
// contract (part E of the TG-NOTIFY-SETTINGS epic, 1.6.1). No database, no
// keys: the resolver, defaults, validators and the pure decision core.
//
// Neutral data only.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_TELEGRAM_NOTIFY_PROACTIVITY_MODE,
  agentProactivityModeOverride,
  defaultTelegramNotifySettings,
  resolveProactivityMode,
  telegramNotifyProactivitySchema,
  telegramNotifySettingsPatchSchema,
} from "./myrmidon-telegram-notify.js";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";

describe("telegram notify proactivity contract", () => {
  it("defaults to the quiet mode and the contract defaults everywhere", () => {
    const defaults = defaultTelegramNotifySettings();
    expect(defaults.proactivity.mode).toBe("only_on_owner_request");
    expect(defaults.proactivity.rarelyMaxPerDay).toBe(3);
    expect(defaults.digest.enabled).toBe(false);
    expect(defaults.errors.enabled).toBe(false);
    expect(defaults.inbound.enabled).toBe(false);
    expect(defaults.escalations.enabled).toBe(false);
  });

  it("accepts every mode and the rarely ceiling bounds", () => {
    for (const mode of ["only_on_owner_request", "rarely", "normal"] as const) {
      expect(
        telegramNotifyProactivitySchema.safeParse({
          mode,
          rarelyMaxPerDay: 3,
        }).success,
      ).toBe(true);
    }
    expect(
      telegramNotifyProactivitySchema.safeParse({
        mode: "loud",
        rarelyMaxPerDay: 3,
      }).success,
    ).toBe(false);
    expect(
      telegramNotifyProactivitySchema.safeParse({
        mode: "rarely",
        rarelyMaxPerDay: 0,
      }).success,
    ).toBe(false);
    expect(
      telegramNotifyProactivitySchema.safeParse({
        mode: "rarely",
        rarelyMaxPerDay: 51,
      }).success,
    ).toBe(false);
  });

  it("PATCH accepts a partial proactivity area and rejects unknown keys", () => {
    expect(
      telegramNotifySettingsPatchSchema.safeParse({
        proactivity: { mode: "rarely" },
      }).success,
    ).toBe(true);
    expect(
      telegramNotifySettingsPatchSchema.safeParse({
        proactivity: { mode: "shouty" },
      }).success,
    ).toBe(false);
    expect(
      telegramNotifySettingsPatchSchema.safeParse({
        proactivity: { mode: "normal", extra: 1 },
      }).success,
    ).toBe(false);
  });
});

describe("proactivity per-agent override", () => {
  it("reads a valid mode from agent metadata", () => {
    expect(agentProactivityModeOverride({ mode: "normal" })).toBe("normal");
    expect(agentProactivityModeOverride({ mode: "rarely" })).toBe("rarely");
  });

  it("ignores malformed overrides — never widens proactivity", () => {
    expect(agentProactivityModeOverride({ mode: "loud" })).toBeNull();
    expect(agentProactivityModeOverride({ mode: 1 })).toBeNull();
    expect(agentProactivityModeOverride({})).toBeNull();
    expect(agentProactivityModeOverride(null)).toBeNull();
    expect(agentProactivityModeOverride("normal")).toBeNull();
  });

  it("the agent override wins over the company default", () => {
    const company = {
      mode: DEFAULT_TELEGRAM_NOTIFY_PROACTIVITY_MODE,
    };
    expect(resolveProactivityMode(company, { mode: "normal" })).toBe("normal");
    expect(resolveProactivityMode(company, {})).toBe(
      DEFAULT_TELEGRAM_NOTIFY_PROACTIVITY_MODE,
    );
    expect(resolveProactivityMode(company, null)).toBe(
      DEFAULT_TELEGRAM_NOTIFY_PROACTIVITY_MODE,
    );
  });
});
