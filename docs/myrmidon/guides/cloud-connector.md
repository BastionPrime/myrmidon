# Clouds: cloud storage through the connector

> Русская версия: [cloud-connector.ru.md](cloud-connector.ru.md)

The cloud connector (CLOUD-CONNECTOR, release 1.4) makes cloud storage a
first-class board module: the owner connects one cloud account per provider,
and folder access is handed out to agents from the board. The access token
lives with the connector — bots and agents never see it.

This guide describes what the code does. Where a piece belongs to a later part
of the feature (part B: OAuth connect and the "Clouds" screen; part C: Google
Drive and Yandex Disk providers), it is marked as such. The module itself is
`server/src/myrmidon/cloud-connector/`; the wire contract is
`packages/shared/src/myrmidon-cloud-connector.ts`.

## How it fits together

- **Accounts.** One connected account per provider. Connecting again for the
  same provider replaces the previous account record. The account stores
  `tokenRef` — the name of the connector-owned secret holding the refresh
  token — never the token itself. Until a token resolver is wired in
  production, every provider call answers `409` ("the account is not
  connected; the owner must connect it first").
- **Roots.** A root is a folder the connector account can reach, with a stable
  lowercase slug (`[a-z0-9-]`, unique per provider) that the owner sees and
  agents address. Two kinds: `own` — a folder path inside the account's drive;
  `shared` — a folder another account shared with the connector account,
  addressed by drive id + item id and always read-only for us.
- **Grants.** The owner grants a root to an agent, a caste, or everyone
  (`all`), with a mode of `ro` (read) or `rw` (read-write). One grant per
  (root, target): re-granting replaces the mode. When several grants match an
  agent, the most specific one wins (`agent` beats `caste` beats `all`); at
  equal specificity `rw` wins.
- **Personal folder.** Each agent gets a personal root automatically on first
  use: the name is `agent-<agent id>` and the folder is `Agents/<agent id>` in
  the account's drive, created if missing and granted `rw` to that agent only.

## Who can do what

- Configuration (accounts, roots, grants, the folder tree, the journal) is
  owner-only: a board user with an active owner role in the company, an
  instance admin, or the local implicit actor. Agents get 403 on all of these;
  unauthenticated callers get 401.
- Agents reach only two things: the list of their own granted roots
  (`GET /api/myrmidon/cloud-connector/roots` returns an agent its slice only)
  and the tool-call endpoint `POST /api/myrmidon/cloud-connector/call`.
- Grant targets of kind `caste` are stored and resolved by the access model,
  but the current tool-call route builds the agent identity with
  `caste: null`, so a caste grant does not match a tool call yet; caste
  matching completes with part B (the agent-facing tool surface).

## Agent tools

The contract defines six tools (`CLOUD_TOOL_NAMES`); in part A they run
through `POST /api/myrmidon/cloud-connector/call` with `{tool, root, ...}`.
Exposure as MCP tools through the tool gateway is part B.

| Tool | What it does |
|---|---|
| `cloud_list` | Lists a folder inside the root (up to 200 entries; `truncated: true` when there are more). |
| `cloud_search` | Searches inside the root by a query (1–200 characters, no quotes or backslashes; up to 20 hits). A hit is returned only when it is verifiably inside the root — the provider walks parents up and drops anything not provably contained. |
| `cloud_read` | Reads a file into memory as base64; the ceiling is 200,000 bytes (`CLOUD_READ_LIMIT_BYTES`). A larger file is refused with "use download". |
| `cloud_download` | Reads a file as base64 with a 64 MiB ceiling (`CLOUD_DOWNLOAD_LIMIT_BYTES`). |
| `cloud_upload` | Writes base64 content to a path (needs `rw`). Missing parent folders are created. Existing name + `overwrite: false` → 409. Small files go in one request; larger ones in a chunked upload session. |
| `cloud_move` | Moves/renames within the same provider (needs `rw` on both source and destination roots). An existing destination → 409. Moving between providers is refused ("not supported"). |

### Addressing: root + path, never an item id

An agent addresses exactly a pair — the root slug and a path inside it. The
connector resolves the path against the provider; provider item ids never come
from the caller. Path rules (`server/src/myrmidon/cloud-connector/paths.ts`):

- separators are normalised (`\` → `/`), empty and `.` segments dropped, names
  compared NFC-normalised and case-insensitively;
- `..` is refused; characters the provider forbids — `"`, `*`, `:`, `<`, `>`,
  `?`, `|`, `\` and control characters — are refused; a segment longer than
  255 characters or a path deeper than 32 segments is refused;
- everything resolves inside the named root — there is no way to address a
  sibling or parent of the root.

### What a refusal means

Every refusal names the boundary the caller hit, never the internals:

- `no access to folder "<root>": it is not granted to this agent` — the root
  is not granted to you (403). Ask the owner for a grant; the name is the
  root slug you sent.
- `folder "<root>" is granted read-only; writing is not allowed` — you have
  `ro`; `cloud_upload`/`cloud_move` are refused (403).
- `the OneDrive account is not connected; the owner must connect it first`
  (409) — no token resolver; an owner-side action, not an agent error.
- Provider failures surface as 403/404/409/502 with a short message; the raw
  provider error type never leaks to the caller.

## Journal

Every tool call — allowed or refused — appends one journal entry: time, actor
(agent id, or the board user id for owner actions), tool, root id and name,
path, ok flag, and a short detail (`listed N entries`, `read name (B bytes)`,
or the refusal text). File contents never reach the journal. The journal keeps
the last 200 entries; the owner reads it at
`GET /api/myrmidon/cloud-connector/journal` (default 100, at most 200).
Removing a root removes its grants but keeps the journal.

## State, settings, operation

- All state (accounts, roots, grants, journal) lives in one JSON document at
  `instance_settings.general.myrmidonCloudConnector` — no database migration;
  an old image keeps working on the schema. Vendor writes of the general
  settings preserve the key (`preserveCloudConnectorGeneralKey` in
  `server/src/services/instance-settings.ts`). Writes run read-modify-write
  under a row lock.
- Part A has **no environment variables** (see
  [../SETTINGS.md](../SETTINGS.md), section "CLOUD-CONNECTOR"). Parts B and C
  add theirs there.
- Providers are a registry (`CloudProviderRegistry`): the OneDrive provider
  (Microsoft Graph) is registered in part A; Google Drive and Yandex Disk
  register the same way in part C, without core changes.
- When connecting fails or access is refused, check in order: the account is
  connected (a `409` says it is not); the root slug is spelled as the owner
  created it; the agent has a grant on that root (the owner sees grants and
  the journal in the same API); the mode allows the operation (`ro` roots
  refuse writes); the journal shows the refusal with the boundary named.

## Limitations

- A folder shared with the connector account by another account is read-only
  by construction: an `rw` grant on a `shared` root is rejected when written
  and ignored when resolved.
- Cloud shortcuts (OneDrive `remoteItem`) are not followed — the entry is
  refused as "a shortcut to another location".
- Moving between cloud providers is not supported.
- One connected account per provider: reconnecting replaces the previous
  account record.
- Uploads, downloads and reads are bounded (200,000-byte reads, 64 MiB
  downloads, 6,000,000 characters of base64 per call).

## API surface

Base path `/api/myrmidon/cloud-connector`; configuration calls take
`companyId` as a query parameter:

```text
GET    /api/myrmidon/cloud-connector/accounts        — owner
POST   /api/myrmidon/cloud-connector/accounts        — owner
DELETE /api/myrmidon/cloud-connector/accounts/:id    — owner
GET    /api/myrmidon/cloud-connector/roots           — owner; agents get their own slice
POST   /api/myrmidon/cloud-connector/roots           — owner
DELETE /api/myrmidon/cloud-connector/roots/:id       — owner
GET    /api/myrmidon/cloud-connector/grants          — owner
PUT    /api/myrmidon/cloud-connector/grants          — owner
DELETE /api/myrmidon/cloud-connector/grants/:id      — owner
GET    /api/myrmidon/cloud-connector/tree            — owner (folder tree of one root)
GET    /api/myrmidon/cloud-connector/journal         — owner
POST   /api/myrmidon/cloud-connector/call            — agent tool call (access-scoped)
```

## Operator notes

- The divergence registry row is CLOUD-CONNECTOR in
  [../DIVERGENCE.md](../DIVERGENCE.md); the module is
  `server/src/myrmidon/cloud-connector/`, mounted in `server/src/app.ts`.
- Acceptance behavior is covered by `*.myrmidon.test.ts` next to the module:
  the access model, path confinement, the route authorization, the OneDrive
  provider (addressing, shortcuts, search confinement, error mapping) and the
  service scenario — an agent reads and writes its own folder, only reads a
  shared one, never reaches another agent's folder, and every call lands in
  the journal.
- The module replaces the temporary `tools/cloud-files` service (see
  [cloud-files-connector.md](cloud-files-connector.md)); path rules were
  ported so the board accepts exactly the paths that service accepted.
