import { describe, expect, it } from "vitest";
import { ApiError } from "@/api/client";
import { accessHubQueryRetry, accessHubUnavailable } from "./accessHubAvailability";

describe("access hub availability", () => {
  it("reads a missing route and an unimplemented route as 'not available yet'", () => {
    expect(accessHubUnavailable(new ApiError("Request failed: 404", 404, null))).toBe(true);
    expect(accessHubUnavailable(new ApiError("Request failed: 501", 501, null))).toBe(true);
  });

  it("keeps every other failure an error", () => {
    expect(accessHubUnavailable(new ApiError("Forbidden", 403, null))).toBe(false);
    expect(accessHubUnavailable(new ApiError("Boom", 500, null))).toBe(false);
    expect(accessHubUnavailable(new Error("network down"))).toBe(false);
    expect(accessHubUnavailable(undefined)).toBe(false);
  });

  it("does not retry a missing route, and keeps the retry budget for real failures", () => {
    const missing = new ApiError("Request failed: 404", 404, null);
    const broken = new ApiError("Boom", 500, null);

    expect(accessHubQueryRetry(0, missing)).toBe(false);
    expect(accessHubQueryRetry(0, broken)).toBe(true);
    expect(accessHubQueryRetry(2, broken)).toBe(true);
    expect(accessHubQueryRetry(3, broken)).toBe(false);
  });
});