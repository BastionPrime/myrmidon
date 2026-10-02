// myrmidon(TRACING-HEALTH) app wiring guard: app.ts mounts the tracing
// health routes under /api with the marker comment. The guard reds when the
// module or the wiring line is missing (vendor code has neither).
//
// Guard recipe: text guard on app.ts (the module-level source, no server
// boot). The red side is proven by stashing the app.ts change (the module
// alone compiles without it): `git stash push -- server/src/app.ts` and
// re-running this file — both assertions fail.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// app.ts lives at src/app.ts (two levels up from this module).
const appSource = readFileSync(path.resolve(__dirname, "../../app.ts"), "utf8");

describe("myrmidon(TRACING-HEALTH) app wiring", () => {
  it("app.ts imports and mounts the tracing health routes with the marker", () => {
    expect(appSource).toContain(
      'import { myrmidonTracingHealthRoutes } from "./myrmidon/tracing-health/index.js"; // myrmidon(TRACING-HEALTH)',
    );
    expect(appSource).toMatch(
      /api\.use\(myrmidonTracingHealthRoutes\(db\)\); \/\/ myrmidon\(TRACING-HEALTH\)/,
    );
  });

  it("the wiring is exactly one import and one mount (the shared one-line integration point)", () => {
    expect(appSource.match(/myrmidonTracingHealthRoutes/g)).toHaveLength(2);
  });
});
