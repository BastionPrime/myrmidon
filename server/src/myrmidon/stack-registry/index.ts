// Stack registry (SUA) entry point. Part A of STACK-UPDATES: component seed,
// local-state collector, cache in instance_settings.general.myrmidonStack and
// the /api/myrmidon/stack API. Part B adds the external release check, the
// scheduled sweep and the attention cards; the panel screen is part C.

export {
  STACK_GENERAL_KEY,
  STACK_DOCUMENT_VERSION,
  STACK_RELEASE_SOURCES,
  STACK_CHECKABLE_RELEASE_SOURCES,
  STACK_LOCAL_PROBES,
  STACK_PATCH_CLOSED_STATES,
  STACK_NOTE_LINE_LIMIT,
  STACK_NOTE_LINE_MAX,
  STACK_SEED,
  STACK_SEED_NAMES,
  emptyStackDocument,
  seedStackDocument,
  seedDeltasFor,
  patchEntryFromDelta,
  parseStackDocument,
  parseUpstreamState,
  type StackDocument,
  type StackSnapshot,
  type StackSeedComponent,
  type StackDeltaSeed,
  type StackReleaseSource,
  type StackLocalProbe,
  type StackLocalState,
  type StackComponentState,
  type StackPatchEntry,
  type StackPatchClosed,
  type StackPatchClosedState,
  type StackReleaseNotes,
  type StackUpstreamState,
} from "./domain.js";
export {
  collectStackLocal,
  dockerImagesPort,
  STACK_DOCKER_SOCKET_ENV,
  DEFAULT_STACK_DOCKER_SOCKET,
  type CollectStackLocalOptions,
  type DockerImagesPort,
  type DockerImageInspectSummary,
} from "./collector.js";
export { readStackDocument, writeStackDocument, preserveStackGeneralKey } from "./store.js";
export { stackRegistryRoutes, myrmidonStackRegistryRoutes, type StackRegistryRouteOptions } from "./routes.js";
export { checkStackReleases, startStackCheckSweep, STACK_CHECK_PER_PAGE, type StackCheckOptions } from "./check.js";
export { STACK_CHECK_INTERVAL_ENV, STACK_CHECK_MIN_INTERVAL_SEC, readStackCheckIntervalSec } from "./settings.js";
export {
  buildStackAttentionCards,
  stackComponentNeedsAttention,
  STACK_ATTENTION_EXCERPT_MAX,
  type StackAttentionCard,
} from "./attention.js";
export {
  STACK_GITHUB_API_BASE,
  STACK_HTTP_TIMEOUT_MS,
  githubJsonPort,
  githubListUrl,
  githubCompareUrl,
  readReleaseList,
  extractReleaseNotes,
  compareContainsFix,
  countBehind,
  normaliseVersion,
  type StackFetchJson,
  type StackHttpResponse,
  type StackReleaseRecord,
} from "./releases.js";