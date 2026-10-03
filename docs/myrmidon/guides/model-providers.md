# Company model providers (registry, write-only keys, model cache)

> Russian version: [model-providers.ru.md](model-providers.ru.md)

A company registers the model providers its agents may use: OpenAI, DashScope,
Google, or any OpenAI-compatible endpoint. The board holds the provider
credential; the value is written to the company secret store once and is never
returned by any endpoint — reads answer only `has_key`.

## What the API offers

All routes live under `/api/myrmidon/companies/:companyId/model-providers`:

| Route | Who | What it does |
|---|---|---|
| `POST …` | board only | Registers a provider. `key` is required and is validated by polling the provider's `/models` endpoint with it; an invalid key answers 422 and nothing is stored. The model list from the successful poll becomes the provider's model cache. |
| `GET …` | company read | Lists the providers: type, name, base URL, `has_key`, free/paid, validation time. Never the key value. |
| `PATCH …/:id` | board only | With `key`: rotates the credential (the new key is validated first; a bad key changes nothing). Without `key`: renames or edits metadata. |
| `DELETE …/:id` | board only | Removes the provider, its model cache and its secret. |
| `GET …/:id/models` | company read | The cached model list captured at key validation. |
| `POST …/:id/models` | board only | Enables/disables models (and marks them free/paid). |

Every mutation writes an activity-log entry (`model_provider_added`,
`model_provider_key_rotated`, `model_provider_removed`) with the provider name
and type — never a key value.

## Where the key lives

The credential is stored in the company secret store under a name derived from
the provider row id (`model-provider-key-<id>`). The database row stores only
that name. The secret is write-only for this module: the server reads the value
only to validate it on create/rotate; no read path of the settings API resolves
it.

## Validation

`POST` and `PATCH` (rotation) poll the provider's OpenAI-compatible `/models`
endpoint with the candidate key before anything is written:

- 401/403 from the provider → 422 "the provider rejected this key";
- network failure → 422 "could not reach the provider";
- an empty model list → 422 (the base URL is likely wrong).

The successful answer is cached as `model_provider_models`, one row per model,
with the `litellm_model_name` the gateway registration (part B) will use.
