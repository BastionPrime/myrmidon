// @vitest-environment jsdom
// myrmidon(ABOUT): tests for the "About Myrmidon" settings section.
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AboutSettingsPanel } from "./AboutSettingsPanel";
import { aboutQueryKey, type AboutInfo } from "./aboutApi";

const mockAboutApi = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock("./aboutApi", () => ({
  aboutApi: mockAboutApi,
  aboutQueryKey: ["myrmidon", "about"],
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const INFO: AboutInfo = {
  product: "Myrmidon",
  version: "1.2.1",
  commit: "0123456789abcdef0123456789abcdef01234567",
  buildDate: "2026-09-28T10:11:12.000Z",
  basePaperclipVersion: "2026.916.1",
  imageDigest: "sha256:" + "a".repeat(64),
  license: "MIT",
  links: {
    repo: "https://github.com/itkadr-git/myrmidon",
    changelog: "https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/CHANGELOG.md",
    docs: "https://github.com/itkadr-git/myrmidon/tree/main/docs/myrmidon",
  },
};

let container: HTMLDivElement;
let root: Root | null;
let queryClient: QueryClient;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = null;
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => {
  flushSync(() => root?.unmount());
  queryClient.clear();
  container.remove();
  vi.clearAllMocks();
});

function renderPanel() {
  root = createRoot(container);
  flushSync(() => {
    root?.render(
      <QueryClientProvider client={queryClient}>
        <AboutSettingsPanel />
      </QueryClientProvider>,
    );
  });
}

describe("AboutSettingsPanel", () => {
  it("renders the version, commit, build date, base, license and links", async () => {
    mockAboutApi.get.mockResolvedValue(INFO);
    renderPanel();
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="myrmidon-about-version"]')).not.toBeNull();
    });
    const text = container.textContent ?? "";
    expect(text).toContain("1.2.1");
    expect(text).toContain("0123456");
    expect(text).toContain("2026.916.1");
    expect(text).toContain("MIT");
    const digest = container.querySelector('[data-testid="myrmidon-about-digest"]');
    expect(digest?.textContent).toContain("sha256:");
    const links = Array.from(container.querySelectorAll("a")).map((a) => a.getAttribute("href"));
    expect(links).toContain(INFO.links.repo);
    expect(links).toContain(INFO.links.changelog);
    expect(links).toContain(INFO.links.docs);
    expect(links).toContain(`${INFO.links.repo}/commit/${INFO.commit}`);
  });

  it("hides absent metadata instead of showing empty rows", async () => {
    mockAboutApi.get.mockResolvedValue({
      ...INFO,
      commit: null,
      buildDate: null,
      imageDigest: null,
      basePaperclipVersion: null,
    });
    renderPanel();
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="myrmidon-about-version"]')).not.toBeNull();
    });
    expect(container.querySelector('[data-testid="myrmidon-about-commit"]')).toBeNull();
    expect(container.querySelector('[data-testid="myrmidon-about-digest"]')).toBeNull();
    expect(container.querySelector('[data-testid="myrmidon-about-base"]')?.textContent).toContain("unknown");
  });

  it("shows the unavailable notice when the about request fails", async () => {
    mockAboutApi.get.mockRejectedValue(new Error("boom"));
    renderPanel();
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="myrmidon-about-error"]')).not.toBeNull();
    });
    expect(container.querySelector('[data-testid="myrmidon-about-version"]')).toBeNull();
  });
});
