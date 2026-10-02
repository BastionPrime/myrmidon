// Stack registry (SUA) entry point. Part A of STACK-UPDATES: component seed,
// local-state collector, cache in instance_settings.general.myrmidonStack and
// the /api/myrmidon/stack API. Scheduled release checks and attention signals
// are part B; the panel screen is part C.

export {
  STACK_GENERAL_KEY,
  STACK_RELEASE_SOURCES,
  STACK_LOCAL_PROBES,
  STACK_SEED,
  STACK_SEED_NAMES,
  emptyStackDocument,
  parseStackDocument,
  type StackDocument,
  type StackSnapshot,
  type StackSeedComponent,
  type StackReleaseSource,
  type StackLocalProbe,
  type StackLocalState,
  type StackComponentState,
  type StackPatchEntry,
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
export { stackRegistryRoutes, myrmidonStackRegistryRoutes } from "./routes.js";
