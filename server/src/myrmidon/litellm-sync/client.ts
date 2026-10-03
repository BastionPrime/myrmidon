// server/src/myrmidon/litellm-sync/client.ts
//
// myrmidon(1.6.1 MODEL-PROVIDERS B): LiteLLM admin API client.
//
// Calls LiteLLM's /model/new, /model/delete, /model/info endpoints using the
// admin key. Never sends credential values - only secret name references.

import { unprocessable } from "../../errors.js";
import { LitellmSyncPort } from "./port.js";

export interface LitellmSyncClientDeps {
  /** The base URL of the LiteLLM instance. */
  litellmBaseUrl: string;
  /** The admin key for LiteLLM model management. */
  litellmAdminKey: string;
}

export function createLitellmSyncClient(deps: LitellmSyncClientDeps): LitellmSyncPort {
  const url = (path: string) => `${deps.litellmBaseUrl.replace(/\/$/, "")}${path}`;

  async function callLiteLLM<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const response = await fetch(url(path), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${deps.litellmAdminKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw unprocessable(`LiteLLM ${path} answered ${response.status}`, {
        code: "litellm_request_failed",
        status: response.status,
      });
    }

    return response.json();
  }

  return {
    async registerModel(input) {
      const payload = {
        model_name: input.litellmModelName,
        litellm_params: {
          model: input.litellmModelName,
          provider: input.providerType,
          api_base: input.baseUrl || undefined,
          // Pass the secret name reference, not the value
          api_key: `secrets/${input.credentialSecretName}`,
          ...input.additionalConfig,
        },
      };

      await callLiteLLM("/model/new", payload);
    },

    async unregisterModel(litellmModelName) {
      const payload = {
        model_names: [litellmModelName],
      };

      await callLiteLLM("/model/delete", payload);
    },

    async listRegisteredModels() {
      const response = await fetch(url("/model/info"), {
        headers: {
          Authorization: `Bearer ${deps.litellmAdminKey}`,
        },
      });

      if (!response.ok) {
        throw unprocessable(`LiteLLM /model/info answered ${response.status}`, {
          code: "litellm_request_failed",
          status: response.status,
        });
      }

      const data = await response.json();
      // Parse the response based on LiteLLM's actual format
      const models = Array.isArray(data?.data) ? data.data : [];
      
      return models.map((model: any) => ({
        litellmModelName: model.model_name || model.id,
        providerType: model.litellm_params?.provider || "",
        baseUrl: model.litellm_params?.api_base || null,
        credentialSecretName: extractSecretName(model.litellm_params?.api_key) || "",
      }));
    },
  };
}

/**
 * Extracts the secret name from an api_key formatted as "secrets/secret-name".
 */
function extractSecretName(apiKey: string | undefined): string | null {
  if (!apiKey || !apiKey.startsWith("secrets/")) {
    return null;
  }
  return apiKey.substring("secrets/".length);
}