// server/src/myrmidon/litellm-sync/port.ts
//
// myrmidon(1.6.1 MODEL-PROVIDERS B): the LiteLLM admin API surface.
//
// LiteLLM (with STORE_MODEL_IN_DB) accepts /model/new, /model/delete, /model/info
// calls to register models dynamically. This module provides the client surface
// for those calls, abstracting the HTTP transport and credential handling.

export interface LitellmSyncPort {
  /**
   * Registers a model in LiteLLM with credential reference.
   * The credential value itself is never passed through this call - only the
   * secret reference that LiteLLM will resolve internally.
   */
  registerModel(input: {
    /** The model name LiteLLM will recognize. */
    litellmModelName: string;
    /** The provider type (e.g., 'openai', 'dashscope'). */
    providerType: string;
    /** The provider's base URL; null means default. */
    baseUrl: string | null;
    /** The name of the secret that holds the credential (not the value itself). */
    credentialSecretName: string;
    /** Additional LiteLLM-specific configuration. */
    additionalConfig?: Record<string, unknown>;
  }): Promise<void>;

  /**
   * Removes a model registration from LiteLLM.
   */
  unregisterModel(litellmModelName: string): Promise<void>;

  /**
   * Fetches the list of currently registered models from LiteLLM.
   */
  listRegisteredModels(): Promise<Array<{
    /** The model name as registered in LiteLLM. */
    litellmModelName: string;
    /** The provider type. */
    providerType: string;
    /** The base URL used. */
    baseUrl: string | null;
    /** The credential secret name reference. */
    credentialSecretName: string;
  }>>;
}