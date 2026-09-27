import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { findPackageCopies, pluginSlug } from "./install.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

describe("plugin-compat install helpers", () => {
  it("builds stable directory names", () => {
    assert.equal(pluginSlug("@scope-a/plugin-a"), "scope-a__plugin-a");
    assert.equal(pluginSlug("plugin-b"), "plugin-b");
  });

  it("finds top-level and nested copies of a package", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-compat-"));
    const write = (dir) => {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "package.json"), "{}");
    };
    write(path.join(root, "node_modules/@paperclipai/plugin-sdk"));
    write(path.join(root, "node_modules/plugin-a/node_modules/@paperclipai/plugin-sdk"));
    write(path.join(root, "node_modules/@paperclipai/shared"));
    const copies = findPackageCopies(root, "@paperclipai/plugin-sdk").map((p) => path.relative(root, p)).sort();
    assert.deepEqual(copies, [
      "node_modules/@paperclipai/plugin-sdk",
      "node_modules/plugin-a/node_modules/@paperclipai/plugin-sdk",
    ]);
  });
});

describe("plugins.json", () => {
  const { plugins } = JSON.parse(fs.readFileSync(path.join(HERE, "plugins.json"), "utf8"));

  it("pins exact versions and has a fixture for every plugin", () => {
    for (const plugin of plugins) {
      assert.match(plugin.version, /^\d+\.\d+\.\d+$/, plugin.name);
      assert.ok(fs.existsSync(path.join(HERE, plugin.fixture)), `${plugin.name} fixture`);
    }
  });

  it("keeps hindsight as a required plugin", () => {
    const hindsight = plugins.find((p) => p.name === "@vectorize-io/hindsight-paperclip");
    assert.equal(hindsight?.required, true);
  });
});
