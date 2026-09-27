import { describe, expect, it } from "vitest";
import { githubCredentialEnvironment } from "./github-credential-environment.js";

describe("GitHub credential environment across the runner boundary (myrmidon P6)", () => {
  it("carries the runtime API URL and candidates for the broker candidate walk", () => {
    const environment = githubCredentialEnvironment({
      PAPERCLIP_GITHUB_BROKER_URL: "https://board.example.com:8443",
      PAPERCLIP_RUNTIME_API_URL: "http://127.0.0.1:3100",
      PAPERCLIP_RUNTIME_API_CANDIDATES_JSON: JSON.stringify(["http://127.0.0.1:3100", "http://198.51.100.20:3100"]),
      UNRELATED_VALUE: "must-not-cross",
    });
    expect(environment.PAPERCLIP_RUNTIME_API_URL).toBe("http://127.0.0.1:3100");
    expect(environment.PAPERCLIP_RUNTIME_API_CANDIDATES_JSON).toBe(
      JSON.stringify(["http://127.0.0.1:3100", "http://198.51.100.20:3100"]),
    );
    expect(environment.PAPERCLIP_GITHUB_BROKER_URL).toBe("https://board.example.com:8443");
    expect(environment.UNRELATED_VALUE).toBeUndefined();
  });
});
