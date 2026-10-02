// Stack registry (SUA): pure model and seed. No I/O here; callers pass inputs.
// Part A of STACK-UPDATES minted the component list, the "ours" local state shape
// and the seed of neutral component descriptors. Part B adds the additive
// upstream state (release lag, release-note highlights, patch-closed rule) and
// raises the document schema to version 2; reading version 1 documents keeps
// working (see parseStackDocument).

export const STACK_GENERAL_KEY = "myrmidonStack";

/**
 * Cached document schema version. Version 1 (part A) carried only the local
 * state; version 2 adds `upstream` per component and `checkedAt` on the
 * document. Read is backward compatible, write is always the current version.
 */
export const STACK_DOCUMENT_VERSION = 2;

/** How the latest upstream release of a component is discovered. */
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

/** Release sources the scheduled check knows how to read. */
export const STACK_CHECKABLE_RELEASE_SOURCES: readonly StackReleaseSource[] = [
  "github-releases",
  "github-tags",
];

/** Evaluation of one carried patch against the upstream range we know about. */
export const STACK_PATCH_CLOSED_STATES = ["closed", "open", "unknown"] as const;
export type StackPatchClosedState = (typeof STACK_PATCH_CLOSED_STATES)[number];

/** How many notable release-note lines a card keeps by default. */
export const STACK_NOTE_LINE_LIMIT = 5;
/** Longest release-note line kept (characters). */
export const STACK_NOTE_LINE_MAX = 200;

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
  /** Carried deltas over upstream, seeded here and evaluated by part B. */
  deltas?: readonly StackDeltaSeed[];
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

/**
 * A carried delta over upstream. The fix-commit list and the pinned version are
 * data, not code: they live in the registry cache and are seeded on the first
 * entry (see STACK_SEED). `state` is filled by the part B patch-closed rule.
 */
export interface StackDeltaSeed {
  /** Short neutral title of the delta. */
  title: string;
  /** Whether the delta is documented in the private deploy repository. */
  private: boolean;
  /** Version/ref we carry the delta on; the GitHub compare base. */
  ourVersion: string | null;
  /** Upstream commits that close (fix) the delta. */
  fixCommits: readonly string[];
}

export interface StackPatchEntry extends StackDeltaSeed {
  /** Evaluation against the current upstream range. */
  state: StackPatchClosedState;
  /** Why the state was decided (null while unknown with no reason). */
  reason: string | null;
}

/** Release-note highlights: notable lines only, bounded. */
export interface StackReleaseNotes {
  /** Security/breaking/CVE-marked lines, top-N, trimmed. */
  lines: string[];
  /** True when the source had more notable lines than kept. */
  truncated: boolean;
  /** Any kept line matched a security marker. */
  hasSecurity: boolean;
}

/** The upstream side of a component: what the last release check learned. */
export interface StackUpstreamState {
  /** When the last check (successful or not) touched this component. */
  checkedAt: string | null;
  /** Latest upstream release/tag name, or null when unknown. */
  latest: string | null;
  /** Publish time of the latest release, when the source provides it. */
  latestPublishedAt: string | null;
  /** When this `latest` value was first seen (stable while it does not change). */
  firstSeenAt: string | null;
  /** Latest seen by the previous check; drives the "new release" signal. */
  previousLatest: string | null;
  /** Releases/tags between our version and latest; null when undeterminable. */
  behindBy: number | null;
  /** Release-note highlights; null when the source carries none. */
  notes: StackReleaseNotes | null;
  /** Probe failure reason for this component, if any. */
  error: string | null;
}

/** Component-level verdict of the patch-closed rule. */
export interface StackPatchClosed {
  state: StackPatchClosedState;
  /** Human-readable reason (which deltas are closed/open, or why unknown). */
  reason: string | null;
}

export interface StackComponentState extends StackLocalState {
  /** Our carried patches over upstream; empty, or seeded and evaluated by part B. */
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
  /** Upstream release state (part B); absent on version 1 documents. */
  upstreamState?: StackUpstreamState;
  /** Patch-closed verdict (part B); absent on version 1 documents. */
  patchClosed?: StackPatchClosed;
}

export interface StackDocument {
  version: typeof STACK_DOCUMENT_VERSION;
  /** ISO time of the last local-state rebuild (POST refresh). */
  refreshedAt: string | null;
  /** ISO time of the last release check (sweep or POST check). */
  checkedAt: string | null;
  components: StackSnapshot[];
}

export function emptyStackDocument(): StackDocument {
  return { version: STACK_DOCUMENT_VERSION, refreshedAt: null, checkedAt: null, components: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function intOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : null;
}

function boolOrFalse(value: unknown): boolean {
  return value === true;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0) : [];
}

/** Read a stored upstream state defensively; null when absent or malformed. */
export function parseUpstreamState(raw: unknown): StackUpstreamState | null {
  if (!isRecord(raw)) return null;
  const notesRaw = raw.notes;
  const notes: StackReleaseNotes | null = isRecord(notesRaw)
    ? {
        lines: stringList(notesRaw.lines),
        truncated: boolOrFalse(notesRaw.truncated),
        hasSecurity: boolOrFalse(notesRaw.hasSecurity),
      }
    : null;
  return {
    checkedAt: str(raw.checkedAt),
    latest: str(raw.latest),
    latestPublishedAt: str(raw.latestPublishedAt),
    firstSeenAt: str(raw.firstSeenAt),
    previousLatest: str(raw.previousLatest),
    behindBy: intOrNull(raw.behindBy),
    notes,
    error: str(raw.error),
  };
}

function parsePatchEntry(raw: unknown): StackPatchEntry | null {
  if (!isRecord(raw) || typeof raw.title !== "string") return null;
  const state = STACK_PATCH_CLOSED_STATES.includes(raw.state as StackPatchClosedState)
    ? (raw.state as StackPatchClosedState)
    : "unknown";
  return {
    title: raw.title,
    private: raw.private === true,
    ourVersion: str(raw.ourVersion),
    fixCommits: stringList(raw.fixCommits),
    state,
    reason: str(raw.reason),
  };
}

function parsePatchClosed(raw: unknown): StackPatchClosed | null {
  if (!isRecord(raw) || !STACK_PATCH_CLOSED_STATES.includes(raw.state as StackPatchClosedState)) return null;
  return { state: raw.state as StackPatchClosedState, reason: str(raw.reason) };
}

function parseLocalState(raw: unknown): StackComponentState {
  const record = isRecord(raw) ? raw : {};
  const patches = Array.isArray(record.patches)
    ? record.patches.map(parsePatchEntry).filter((entry): entry is StackPatchEntry => entry !== null)
    : [];
  return {
    version: str(record.version),
    commit: str(record.commit),
    digest: str(record.digest),
    runningOn: str(record.runningOn),
    unknownReason: str(record.unknownReason),
    checkedAt: str(record.checkedAt),
    patches,
  };
}

/**
 * Read the stored document defensively: anything malformed is an empty seed
 * view. Version 1 documents (no `upstream`/`checkedAt`) upgrade transparently —
 * their components simply have no upstream state yet.
 */
export function parseStackDocument(raw: unknown): StackDocument {
  if (!isRecord(raw) || !Array.isArray(raw.components)) return emptyStackDocument();
  const components = raw.components
    .filter(
      (c): c is Record<string, unknown> =>
        isRecord(c) &&
        typeof c.name === "string" &&
        STACK_RELEASE_SOURCES.includes(c.releaseSource as StackReleaseSource) &&
        STACK_LOCAL_PROBES.includes(c.localProbe as StackLocalProbe) &&
        isRecord(c.local),
    )
    .map((c): StackSnapshot => {
      const upstreamState = parseUpstreamState(c.upstreamState);
      const patchClosed = parsePatchClosed(c.patchClosed);
      return {
        version: 1,
        name: c.name as string,
        releaseSource: c.releaseSource as StackReleaseSource,
        upstream: isRecord(c.upstream) && c.upstream.kind === "github" && typeof c.upstream.repo === "string"
          ? { kind: "github", repo: c.upstream.repo }
          : { kind: "manual" },
        localProbe: c.localProbe as StackLocalProbe,
        ...(typeof c.note === "string" ? { note: c.note } : {}),
        local: parseLocalState(c.local),
        ...(upstreamState ? { upstreamState } : {}),
        ...(patchClosed ? { patchClosed } : {}),
      };
    });
  return {
    version: STACK_DOCUMENT_VERSION,
    refreshedAt: str(raw.refreshedAt),
    checkedAt: str(raw.checkedAt),
    components,
  };
}

/** Build a patch entry from a seeded delta, before any check has run. */
export function patchEntryFromDelta(delta: StackDeltaSeed): StackPatchEntry {
  return {
    title: delta.title,
    private: delta.private,
    ourVersion: delta.ourVersion,
    fixCommits: [...delta.fixCommits],
    state: "unknown",
    reason: null,
  };
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
    // First entry of the carried-delta list: the gateway thread-pool patch. The
    // upstream commit that closes it is data, not code (see StackDeltaSeed).
    deltas: [
      {
        title: "gateway turn-body thread pool patch",
        private: true,
        ourVersion: "v2026.9.24",
        fixCommits: ["24758cf4b8"],
      },
    ],
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

/** Seed deltas for one component (empty when it carries none). */
export function seedDeltasFor(name: string): readonly StackDeltaSeed[] {
  return STACK_SEED.find((seed) => seed.name === name)?.deltas ?? [];
}

/**
 * The document before any probe has run: the seed components with empty local
 * state and their seeded patches. Used as the base for a check when the cache
 * is still empty and as the GET fallback view.
 */
export function seedStackDocument(): StackDocument {
  return {
    version: STACK_DOCUMENT_VERSION,
    refreshedAt: null,
    checkedAt: null,
    components: STACK_SEED.map((seed): StackSnapshot => ({
      version: 1,
      name: seed.name,
      releaseSource: seed.releaseSource,
      upstream: seed.upstream,
      localProbe: seed.localProbe,
      ...(seed.note ? { note: seed.note } : {}),
      local: {
        version: null,
        commit: null,
        digest: null,
        runningOn: null,
        unknownReason: "not refreshed yet",
        checkedAt: null,
        patches: seedDeltasFor(seed.name).map(patchEntryFromDelta),
      },
    })),
  };
}