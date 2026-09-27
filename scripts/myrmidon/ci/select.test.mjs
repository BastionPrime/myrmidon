import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyChanges, importSpecifiers, selectTests } from "./select.mjs";

const packages = [
  { name: "@paperclipai/server", dir: "server" },
  { name: "@paperclipai/ui", dir: "ui" },
  { name: "paperclipai", dir: "cli" },
  { name: "@paperclipai/adapter-a-local", dir: "packages/adapters/a-local" },
  { name: "@paperclipai/adapter-b-local", dir: "packages/adapters/b-local" },
];

const testFiles = [
  { file: "server/src/__tests__/a-adapter.test.ts", source: 'import { x } from "@paperclipai/adapter-a-local/server";' },
  { file: "server/src/__tests__/b-adapter.test.ts", source: 'vi.mock("@paperclipai/adapter-b-local");' },
  { file: "server/src/__tests__/heartbeat.test.ts", source: 'import { heartbeat } from "../services/heartbeat.js";' },
  { file: "server/src/services/heartbeat.local.test.ts", source: 'const m = await import("./heartbeat.js");' },
  { file: "server/src/__tests__/unrelated.test.ts", source: 'import { y } from "../services/other.js";' },
  { file: "ui/src/components/Card.test.tsx", source: 'import { Card } from "./Card";' },
  { file: "packages/adapters/a-local/src/server/execute.test.ts", source: 'import { execute } from "./execute.js";' },
];

describe("classifyChanges", () => {
  it("forces the full tier for shared foundations", () => {
    for (const file of [
      "pnpm-lock.yaml",
      "package.json",
      "packages/db/src/schema/issues.ts",
      "packages/shared/src/constants.ts",
      ".github/workflows/myrmidon-ci.yml",
      "scripts/run-vitest-stable.mjs",
      "packages/paperclip-runner/src/index.ts",
      "scripts/myrmidon/ci/select.mjs",
    ]) {
      assert.equal(classifyChanges([file]).tier, "full", file);
    }
  });

  it("keeps Myrmidon docs and scripts in the docs tier", () => {
    const result = classifyChanges(["docs/myrmidon/tracks/1.md", "scripts/myrmidon/deploy/deploy.sh", "NOTICE"]);
    assert.equal(result.tier, "docs");
  });

  it("uses the fast tier for an adapter change", () => {
    assert.equal(classifyChanges(["packages/adapters/a-local/src/server/execute.ts"]).tier, "fast");
  });

  it("treats vendor docs read by tests as code", () => {
    assert.equal(classifyChanges(["docs/api/issues.md"]).tier, "fast");
  });

  it("honours a forced full run", () => {
    assert.equal(classifyChanges(["docs/myrmidon/ci.md"], { forceFull: true }).tier, "full");
  });
});

describe("importSpecifiers", () => {
  it("finds static, dynamic, mock and require specifiers", () => {
    const source = [
      'import a from "a";',
      'import { b } from "./b.js";',
      'import "./side-effect";',
      'const c = await import("c/sub");',
      'vi.mock("@scope/d");',
      'const e = require("e");',
    ].join("\n");
    assert.deepEqual(importSpecifiers(source).sort(), ["./b.js", "./side-effect", "@scope/d", "a", "c/sub", "e"].sort());
  });
});

describe("selectTests", () => {
  it("tests a changed adapter whole plus direct importers elsewhere", () => {
    const result = selectTests(["packages/adapters/a-local/src/server/execute.ts"], packages, testFiles);
    assert.deepEqual(result.wholePackages, ["@paperclipai/adapter-a-local"]);
    assert.deepEqual(result.files, [{ package: "@paperclipai/server", files: ["server/src/__tests__/a-adapter.test.ts"] }]);
  });

  it("never tests the server whole: only tests importing the changed module", () => {
    const result = selectTests(["server/src/services/heartbeat.ts"], packages, testFiles);
    assert.deepEqual(result.wholePackages, []);
    assert.deepEqual(result.files, [
      {
        package: "@paperclipai/server",
        files: ["server/src/__tests__/heartbeat.test.ts", "server/src/services/heartbeat.local.test.ts"],
      },
    ]);
  });

  it("selects a changed test file itself", () => {
    const result = selectTests(["ui/src/components/Card.test.tsx"], packages, testFiles);
    assert.deepEqual(result.files, [{ package: "@paperclipai/ui", files: ["ui/src/components/Card.test.tsx"] }]);
  });

  it("follows mocks of a changed package", () => {
    const result = selectTests(["packages/adapters/b-local/src/index.ts"], packages, testFiles);
    assert.deepEqual(result.files, [{ package: "@paperclipai/server", files: ["server/src/__tests__/b-adapter.test.ts"] }]);
  });

  it("selects nothing for a change nobody imports", () => {
    const result = selectTests(["server/src/services/lonely.ts"], packages, testFiles);
    assert.deepEqual(result, { wholePackages: [], files: [] });
  });
});
