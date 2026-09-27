import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyChanges,
  compareStableTags,
  decideSync,
  extractPrNumbers,
  findPossiblyRemovableRows,
  parseDivergence,
  parseNameStatus,
  pickLatestStable,
  rowTouchesFile,
} from "./lib.mjs";

describe("stable tags", () => {
  it("accepts only vYYYY.MDD.N", () => {
    assert.equal(
      pickLatestStable([
        "v2026.916.1",
        "v2026.927.0-canary.4",
        "canary/v2026.927.0-canary.4",
        "nightly/v2026.927.0-nightly.0",
        "v2026.927.0-beta.1",
        "v2026.927.0-rc.1",
        "@paperclipai/server@1.2.3",
        "v2026.916.0",
      ]),
      "v2026.916.1",
    );
    assert.equal(pickLatestStable(["v2026.927.0-canary.1"]), null);
  });

  it("compares numerically, including four-digit month-day", () => {
    assert.ok(compareStableTags("v2026.1007.0", "v2026.930.5") > 0);
    assert.ok(compareStableTags("v2027.101.0", "v2026.1231.9") > 0);
    assert.ok(compareStableTags("v2026.916.10", "v2026.916.9") > 0);
    assert.equal(compareStableTags("v2026.916.1", "v2026.916.1"), 0);
  });

  it("decides nothing when the base is current or newer", () => {
    assert.equal(decideSync({ latestVendorTag: "v2026.916.1", baseTag: "v2026.916.1" }).action, "nothing");
    assert.equal(decideSync({ latestVendorTag: null, baseTag: "v2026.916.1" }).action, "nothing");
    assert.deepEqual(decideSync({ latestVendorTag: "v2026.927.0", baseTag: "v2026.916.1" }), {
      action: "sync",
      tag: "v2026.927.0",
      base: "v2026.916.1",
      reason: null,
    });
  });
});

describe("registry", () => {
  const markdown = `# R

## Трек 2

| ID | Что меняем | Файлы вендора | Причина | Тест-сторож | Как снимать | PR |
|---|---|---|---|---|---|---|
| P3 | cap history | \`server/src/services/execution-continuation.ts\` + \`server/src/myrmidon/cap.ts\` | long history | t | when vendor merges #13891 | #5 |
| vendor:6d03428 | chat id | \`server/src/routes/**\` | #13654 | t | leaves with the tag | #6 |

## Трек 5

| ID | Что меняем | Файлы вендора | Причина | Тест-сторож | Как снимать | PR |
|---|---|---|---|---|---|---|
`;

  it("parses rows per section and ignores empty tables", () => {
    const rows = parseDivergence(markdown);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].section, "Трек 2");
    assert.equal(rows[0].id, "P3");
    assert.equal(rows[1].cells["Как снимать"], "leaves with the tag");
  });

  it("matches vendor files, not our new files", () => {
    const [p3, vendorRow] = parseDivergence(markdown);
    assert.ok(rowTouchesFile(p3, "server/src/services/execution-continuation.ts"));
    assert.ok(!rowTouchesFile(p3, "server/src/myrmidon/cap.ts"));
    assert.ok(rowTouchesFile(vendorRow, "server/src/routes/chat.ts"));
  });

  it("finds rows whose vendor PR or commit is in the range", () => {
    const rows = parseDivergence(markdown);
    const found = findPossiblyRemovableRows(rows, {
      prNumbers: extractPrNumbers(["fix: x (#13891)", "fix: y (#1)"]),
      commitShas: ["6d0342868aaaaaaa"],
    });
    assert.deepEqual(
      found.map((f) => [f.row.id, f.reasons]),
      [
        ["P3", ["vendor #13891 is in the range"]],
        ["vendor:6d03428", ["commit 6d03428 is in the range"]],
      ],
    );
  });
});

describe("changes", () => {
  it("classifies workflows, migrations, marked and dependency files", () => {
    const changes = parseNameStatus(
      [
        "A\t.github/workflows/new.yml",
        "M\t.github/workflows/pr.yml",
        "A\tpackages/db/src/migrations/0285_x.sql",
        "A\tpackages/db/src/migrations/meta/0285_snapshot.json",
        "M\tserver/src/services/heartbeat.ts",
        "R087\tserver/src/old.ts\tserver/src/new.ts",
        "M\tpnpm-lock.yaml",
        "M\tserver/package.json",
        "M\tDockerfile.cloud",
      ].join("\n"),
    );
    const c = classifyChanges(changes, { markedFiles: ["server/src/services/heartbeat.ts", "server/src/old.ts"] });
    assert.deepEqual(c.workflows.map((x) => x.path), [".github/workflows/new.yml", ".github/workflows/pr.yml"]);
    assert.deepEqual(c.migrations.map((x) => x.path), ["packages/db/src/migrations/0285_x.sql"]);
    assert.deepEqual(c.marked.map((x) => x.path), ["server/src/services/heartbeat.ts", "server/src/new.ts"]);
    assert.deepEqual(c.dependencies.map((x) => x.path), ["pnpm-lock.yaml", "server/package.json", "Dockerfile.cloud"]);
  });
});
