// myrmidon(1.7-METRICS): wiring guard. The endpoint must be reachable from
// the server entry point: one import behind the 1.7-METRICS marker and one
// origin-root mount of the router. This suite is red when the module is
// missing or the entry point lost its wiring — the "guard test is red
// without the module, green with it" acceptance case: cutting the module
// removes the import, and this file then fails to resolve it.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { myrmidonMetricsApp, METRICS_TOKEN_ENV, METRICS_TOKEN_SECRET_ENV } from "./index.js";

const APP_TS = fileURLToPath(new URL("../../../app.ts", import.meta.url));

describe("metrics wiring guard", () => {
  it("the server entry point imports the module behind the 1.7-METRICS marker", () => {
    const source = readFileSync(APP_TS, "utf8");
    const importLines = source.split("\n").filter((line: string) =>
      line.includes("myrmidon/monitoring/metrics"),
    );
    expect(importLines.length).toBe(1);
    expect(importLines[0]).toContain("myrmidon(1.7-METRICS)");
  });

  it("the router is mounted at the origin root (outside /api) exactly once", () => {
    const source = readFileSync(APP_TS, "utf8");
    const mountLines = source
      .split("\n")
      .filter((line: string) => line.includes("app.use(myrmidonMetricsApp("));
    expect(mountLines.length).toBe(1);
    expect(mountLines[0]).toContain("myrmidon(1.7-METRICS)");
    // The mount is NOT an /api mount: the line must not address /api.
    expect(mountLines[0]).not.toContain('"/api"');
  });

  it("the token settings are documented in SETTINGS.md", () => {
    const text = readFileSync(
      fileURLToPath(new URL("../../../../../docs/myrmidon/SETTINGS.md", import.meta.url)),
      "utf8",
    );
    expect(text).toContain(METRICS_TOKEN_SECRET_ENV);
    expect(text).toContain(METRICS_TOKEN_ENV);
  });

  it("the module is registered in the DIVERGENCE.md divergence registry", () => {
    const text = readFileSync(
      fileURLToPath(new URL("../../../../../docs/myrmidon/DIVERGENCE.md", import.meta.url)),
      "utf8",
    );
    expect(text).toContain("1.7-METRICS");
  });

  it("the app builder returns a router", () => {
    // A bare in-memory stand-in: the router is stateless, no db read happens
    // at construction time.
    const router = myrmidonMetricsApp({} as never);
    expect(typeof router).toBe("function");
  });
});
