// Stack registry (SUA): pure model and seed. No I/O here; callers pass inputs.
// Part A of STACK-UPDATES: the component list, the "ours" local state shape and
// the seed of neutral component descriptors. Release-source checking and the
// scheduled comparison land in part B; this module only models what part A owns.

export const STACK_GENERAL_KEY = "myrmidonStack";

/** How the latest upstream release of a component is discovered (part B). */
export const STACK_RELEASE_SOURCES = [
  "github-releases",
  "github-tags",
  "registry",
  "package",
  "manual",
] as const;
export type StackReleaseSource = (typeof STACK_RELEASE_SOURCES)[number];

/** How the locally running version of a component is discovered. */
export const STACK_LOCAL_PROBES = [
  "health-commit", // the board server itself: the /api/health commit source
  "docker-image", // image digest/labels via the Docker API over the unix socket
  "container-labels", // version reported by container labels
  "env", // an explicit MYRMIDON_* version override
  "manual", // filled by the operator; no probe exists
  "none", // no local probe: reported as unknown with a reason
] as const;
export type StackLocalProbe = (typeof STACK_LOCAL_PROBES)[number];

export interface StackSeedComponent {
  /** Neutral public name (lowercase-kebab); no hosts, no internal ids. */
  name: string;
  releaseSource: StackReleaseSource;
  /** Upstream project coordinates for release checks (part B); public data. */
  upstream: { kind: "github"; repo: string } | { kind: "manual" };
  localProbe: StackLocalProbe;
  /** For docker-image probes: image reference(s) to inspect, without a tag. */
  imageRefs?: readonly string[];
  /** One-line note shown next to the component in the panel. */
  note?: string;
}

export interface StackLocalState {
  /** Human-readable running version, or null when unknown. */
  version: string | null;
  /** Commit the component was built from, when known (the board: health commit). */
  commit: string | null;
  /** Image digest (docker-image probes), when known. */
  digest: string | null;
  /** Where the component runs, in neutral terms; null when unknown. */
  runningOn: string | null;
  /** When the local probe produced no value: why it is unknown. */
  unknownReason: string | null;
  /** Probed at (ISO); null while the first refresh has not run. */
  checkedAt: string | null;
}

/** A delta we carry on top of upstream; populated by the rules in part B. */
export interface StackPatchEntry {
  /** Short neutral title of the delta. */
  title: string;
  /** Whether the delta is documented in the private deploy repository. */
  private: boolean;
}

export interface StackComponentState extends StackLocalState {
  /** Our carried patches over upstream; starts empty, filled by part B. */
  patches: readonly StackPatchEntry[];
}

export interface StackSnapshot {
  version: 1;
  name: string;
  releaseSource: StackReleaseSource;
  upstream: StackSeedComponent["upstream"];
  localProbe: StackLocalProbe;
  note?: string;
  local: StackComponentState;
}

export interface StackDocument {
  version: 1;
  /** ISO time of the last local-state rebuild (POST refresh). */
  refreshedAt: string | null;
  components: StackSnapshot[];
}

export function emptyStackDocument(): StackDocument {
  return { version: 1, refreshedAt: null, components: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Read the stored document defensively: anything malformed is an empty seed view. */
export function parseStackDocument(raw: unknown): StackDocument {
  if (!isRecord(raw) || !Array.isArray(raw.components)) return emptyStackDocument();
  const components = raw.components.filter(
    (c): c is StackSnapshot =>
      isRecord(c) &&
      typeof c.name === "string" &&
      STACK_RELEASE_SOURCES.includes(c.releaseSource as StackReleaseSource) &&
      STACK_LOCAL_PROBES.includes(c.localProbe as StackLocalProbe) &&
      isRecord(c.local),
  );
  return { version: 1, refreshedAt: str(raw.refreshedAt), components };
}

/**
 * The seed: every stack component the update panel tracks. Neutral public
 * names and upstream repos only — no hosts, no internal identifiers.
 */
export const STACK_SEED: readonly StackSeedComponent[] = [
  {
    name: "paperclip",
    releaseSource: "github-releases",
    upstream: { kind: "github", repo: "paperclipai/paperclip" },
    localProbe: "manual",
    note: "Vendor upstream of the board fork; local version tracked via the board component.",
  },
  {
    name: "myrmidon",
    releaseSource: "github-tags",
    upstream: { kind: "github", repo: "itkadr-git/myrmidon" },
    localProbe: "health-commit",
    note: "The board itself; version/commit come from the /api/health source.",
  },
  {
    name: "hermes-agent",
    releaseSource: "github-releases",
    upstream: { kind: "github", repo: "NousResearch/hermes-agent" },
    localProbe: "docker-image",
    imageRefs: ["ghcr.io/nousresearch/hermes-agent"],
  },
  {
    name: "litellm",
    releaseSource: "github-releases",
    upstream: { kind: "github", repo: "BerriAI/litellm" },
    localProbe: "docker-image",
    imageRefs: ["ghcr.io/berriai/litellm"],
  },
  {
    name: "ragflow",
    releaseSource: "github-releases",
    upstream: { kind: "github", repo: "infiniflow/ragflow" },
    localProbe: "docker-image",
    imageRefs: ["infiniflow/ragflow"],
  },
  {
    name: "hindsight",
    releaseSource: "github-releases",
    upstream: { kind: "github", repo: "vectorize-io/hindsight" },
    localProbe: "manual",
  },
  {
    name: "langfuse",
    releaseSource: "github-releases",
    upstream: { kind: "github", repo: "langfuse/langfuse" },
    localProbe: "docker-image",
    imageRefs: ["langfuse/langfuse"],
  },
  {
    name: "clickhouse",
    releaseSource: "github-releases",
    upstream: { kind: "github", repo: "ClickHouse/ClickHouse" },
    localProbe: "docker-image",
    imageRefs: ["clickhouse/clickhouse-server"],
  },
  {
    name: "zabbix",
    releaseSource: "github-tags",
    upstream: { kind: "github", repo: "zabbix/zabbix" },
    localProbe: "manual",
    note: "Integration settings live in the maintenance module; the server version is operator-managed.",
  },
  {
    name: "playwright-chromium-mcp",
    releaseSource: "github-releases",
    upstream: { kind: "github", repo: "microsoft/playwright-mcp" },
    localProbe: "manual",
  },
  {
    name: "dockergate",
    releaseSource: "manual",
    upstream: { kind: "manual" },
    localProbe: "manual",
    note: "Internal image without a public release feed; the operator pins the version.",
  },
  {
    name: "media-tools",
    releaseSource: "manual",
    upstream: { kind: "manual" },
    localProbe: "manual",
    note: "Runs as a service outside the board image; the operator pins the version.",
  },
  {
    name: "base-images",
    releaseSource: "registry",
    upstream: { kind: "manual" },
    localProbe: "docker-image",
    imageRefs: ["node", "ghcr.io/itkadr-git/myrmidon"],
    note: "Base images the board and its bots run on: the public node image family and the board image.",
  },
  {
    name: "proxmox-ve",
    releaseSource: "manual",
    upstream: { kind: "manual" },
    localProbe: "none",
    note: "Hypervisor level; not visible from the board server process.",
  },
  {
    name: "node-os",
    releaseSource: "manual",
    upstream: { kind: "manual" },
    localProbe: "none",
    note: "Operating systems of the deployment nodes; not visible from the board server process.",
  },
];

export const STACK_SEED_NAMES: readonly string[] = STACK_SEED.map((c) => c.name);
