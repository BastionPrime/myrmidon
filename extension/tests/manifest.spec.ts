import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The manifest is a security artifact: permissions, hosts and code entries
// are asserted, not reviewed by eye. The same gates run in CI
// (.github/workflows/myrmidon-extension.yml); these tests fail first and
// with a clearer message.

const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(resolve(here, "../manifest.json"), "utf8"));

describe("manifest.json", () => {
  it("is a Manifest V3 extension", () => {
    expect(manifest.manifest_version).toBe(3);
  });

  it("requests the minimal permission set (no tabs.onUpdate, no webRequest)", () => {
    expect([...manifest.permissions].sort()).toEqual(["storage", "tabs"]);
  });

  it("limits host permissions to the outbound bridge socket", () => {
    expect([...manifest.host_permissions].sort()).toEqual(["wss://*/*"]);
  });

  it("loads only local code: service worker, content script, popup, options", () => {
    expect(manifest.background.service_worker).toMatch(/^entry-background\.js$/);
    expect(manifest.action.default_popup).toMatch(/^popup\/popup\.html$/);
    expect(manifest.options_page).toMatch(/^options\/options\.html$/);
    for (const entry of manifest.content_scripts) {
      for (const script of entry.js) {
        expect(script).toMatch(/^entry-content\.js$/);
      }
    }
  });

  it("registers the content script on all pages but isolates it by design", () => {
    expect(manifest.content_scripts).toHaveLength(1);
    expect(manifest.content_scripts[0].matches).toContain("http://*/*");
    expect(manifest.content_scripts[0].matches).toContain("https://*/*");
    expect(manifest.content_scripts[0].all_frames).toBe(false);
  });
});

describe("protocol copy (part B contract mirror)", () => {
  const protocol = readFileSync(resolve(here, "../src/protocol.ts"), "utf8");

  it("keeps the bridge method set in sync with the gateway contract", () => {
    expect(protocol).toContain(`"browser.open"`);
    expect(protocol).toContain(`"browser.read"`);
    expect(protocol).toContain(`"browser.click"`);
    expect(protocol).toContain(`"browser.fill"`);
    expect(protocol).toContain(`"browser.download"`);
    expect(protocol).toContain(`"browser.screenshot"`);
  });

  it("keeps the timeouts at the design-note values (30 s / 180 s)", () => {
    expect(protocol).toContain("BRIDGE_ACTION_TIMEOUT_MS = 30_000");
    expect(protocol).toContain("BRIDGE_CONFIRMATION_TIMEOUT_MS = 180_000");
  });

  it("keeps the wire paths and protocol revision at the contract values", () => {
    expect(protocol).toContain('"/bridge/v1"');
    expect(protocol).toContain('"/bridge/v1/pair"');
    expect(protocol).toContain("BRIDGE_PROTOCOL_VERSION = 1");
  });

  it("declares the read-only set plus the part D primitives, and never sign", () => {
    for (const capability of ['"open"', '"read"', '"click"', '"fill"', '"download"', '"screenshot"']) {
      expect(protocol).toContain(capability);
    }
    // Signing is never automated by the extension: the helper owns the key and
    // the PIN, so the extension declares no sign capability at all.
    expect(protocol).not.toContain('"sign"');
  });
});
