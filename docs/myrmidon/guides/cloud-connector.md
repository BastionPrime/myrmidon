# Clouds: cloud storage through the connector

> Русская версия: [cloud-connector.ru.md](cloud-connector.ru.md)

The cloud connector (CLOUD-CONNECTOR, release 1.4) makes cloud storage a
first-class board module: the owner connects one cloud account per provider
from the panel, and folder access is handed out to agents from the same place.
The OAuth token lives in the instance secret store as a company secret — bots
and agents never see it.

The module is `server/src/myrmidon/cloud-connector/`; the wire contract is
`packages/shared/src/myrmidon-cloud-connector.ts`; the owner UI is
Settings → Clouds (`company/settings/clouds`).

## How it fits together

- **Accounts.** One connected account per provider per company. The owner
  connects from Settings → Clouds: **Connect** starts OAuth
  (`POST /api/myrmidon/cloud-connector/oauth/:providerId/start` returns the
  provider's authorize URL with a single-use state, PKCE where the provider
  supports it), the provider returns to
  `GET /api/myrmidon/cloud-connector/oauth/callback`, and the token bundle
  (access + refresh + expiry) is written as a company secret named
  `myrmidon-cloud-<provider>` in the instance secret store. The connector
  state keeps only the secret id — the token value never passes through the
  board API. Before a provider call, the access token is refreshed
  automatically when it is within 60 seconds of expiry
  (`CLOUD_TOKEN_REFRESH_SKEW_MS`), with concurrent refreshes of the same
  account deduplicated and the new bundle written back under a version guard.
  A folder whose company has no connected account answers a cloud call with
  `409 not connected`.
- **Roots.** A root is a folder the connector account can reach, with a stable
  lowercase slug (`[a-z0-9-]`, unique per provider) that the owner sees and
  agents address. Two kinds: `own` — a folder path inside the account's drive;
  `shared` — a folder another account shared with the connector account,
  addressed by drive id + item id and always read-only for us. Yandex Disk has
  no shared-drive addressing, so a `shared` root on Yandex is refused with
  "record this folder as an own root instead".
- **Grants.** The owner grants a root to an agent, a caste, or everyone
  (`all`), with a mode of `ro` (read) or `rw` (read-write). One grant per
  (root, target): re-granting replaces the mode. When several grants match an
  agent, the most specific one wins (`agent` beats `caste` beats `all`); at
  equal specificity `rw` wins. A caste grant matches the agent's board role
  (`agents.role`), read per call — an agent whose role is empty has no caste
  and only matches grants to the agent itself or to everyone.
- **Personal folder.** The root name `personal` is reserved
  (`CLOUD_PERSONAL_ROOT_ALIAS`): it always means the calling agent's own
  folder. On first use the connector creates it (`Agents/<agent id>` in the
  account's drive, root name `agent-<agent id>`) and grants it `rw` to that
  agent only. The owner cannot create a root named `personal` — the answer is
  `400 reserved`. The alias resolves against the one cloud the agent's company
  has connected; with no connected account, with an unknown company, or with
  several connected clouds, the agent gets a `409` refusal that names the
  providers and asks the owner which folder is theirs.

## Who can do what

- Configuration (accounts, roots, grants, the folder tree, the journal) is
  owner-only: a board user with an active owner role in the company, an
  instance admin, or the local implicit actor. Agents get 403 on all of these;
  unauthenticated callers get 401.
- Agents reach three things: the list of their own granted roots
  (`GET /api/myrmidon/cloud-connector/roots` returns an agent its slice only),
  the tool-call endpoint `POST /api/myrmidon/cloud-connector/call`, and the
  MCP surface `POST /api/mcp/cloud-tools`.
- Both agent entry points build the caller identity the same way
  (`identity.ts`): the agent id, its company, and its board role as the caste
  label — so the two surfaces cannot disagree about who is calling or which
  grants apply.

## Agent tools

Six tools (`CLOUD_TOOL_NAMES`), reachable two ways that share one service —
so grants, path confinement and the journal apply identically:

- `POST /api/myrmidon/cloud-connector/call` with `{tool, root, ...}`;
- the MCP endpoint `POST /api/mcp/cloud-tools` (JSON-RPC: `initialize`,
  `notifications/initialized`, `tools/list`, `tools/call`). The `root`
  argument description in `tools/list` tells the agent about the reserved
  `personal` name. A board user or an anonymous caller gets 401 there; a
  refusal arrives as a tool error naming the boundary.

| Tool | What it does |
|---|---|
| `cloud_list` | Lists a folder inside the root (up to 200 entries; `truncated: true` when there are more). |
| `cloud_search` | Searches inside the root by a query (1–200 characters, no quotes or backslashes; up to 20 hits). A hit is returned only when it is verifiably inside the root. Yandex Disk has no search API, so there `search` walks the granted root (bounded depth and item count) — a hit outside the root is impossible by construction. |
| `cloud_read` | Reads a file into memory as base64; the ceiling is 200,000 bytes (`CLOUD_READ_LIMIT_BYTES`). A larger file is refused with "use download". |
| `cloud_download` | Reads a file as base64 with a 64 MiB ceiling (`CLOUD_DOWNLOAD_LIMIT_BYTES`). |
| `cloud_upload` | Writes base64 content to a path (needs `rw`). Missing parent folders are created. Existing name + `overwrite: false` → 409. Small files go in one request; larger ones in a chunked/resumable upload session. |
| `cloud_move` | Moves/renames within the same provider (needs `rw` on both source and destination roots). An existing destination → 409. Moving between providers is refused ("not supported"). |

### Addressing: root + path, never an item id

An agent addresses exactly a pair — the root slug (or `personal`) and a path
inside it. The connector resolves the path against the provider; provider item
ids never come from the caller. Path rules
(`server/src/myrmidon/cloud-connector/paths.ts`):

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
  is not granted to you (403). Ask the owner for a grant.
- `folder "<root>" is granted read-only; writing is not allowed` — you have
  `ro`; `cloud_upload`/`cloud_move` are refused (403).
- `the OneDrive account is not connected; the owner must connect it first`
  (409) — the company has no connected account for that provider; an
  owner-side action, not an agent error.
- `"personal" is not available yet: no cloud account is connected for this
  company…` / `"personal" is ambiguous here: this company has accounts for
  <providers>…` (409) — the reserved alias could not resolve; use the folder
  name the owner gave you.
- Provider failures surface as 403/404/409/502 with a short message; the raw
  provider error type never leaks to the caller.

## Journal

Every tool call that reaches the executor — allowed or refused — appends one
journal entry: time, actor (the calling agent's id), tool, root id and name,
path, ok flag, and a short detail (`listed N entries`, `read name (B bytes)`,
or the refusal text). File contents never reach the journal. The journal keeps
the last 200 entries; the owner reads it at
`GET /api/myrmidon/cloud-connector/journal` (default 100, at most 200).
Removing a root removes its grants but keeps the journal.

## State, settings, operation

- Connector state (accounts, roots, grants, journal) lives in one JSON
  document at `instance_settings.general.myrmidonCloudConnector` — no database
  migration. The owner's token never lives there: it is a company secret of
  the instance secret store (`myrmidon-cloud-<provider>`), written by the
  connect flow and rotated on every automatic refresh. Accounts and roots are
  scoped to the owner's company, and a provider gets the token of the company
  that owns the root. Writes run read-modify-write under a row lock; vendor
  writes of the general settings preserve the key
  (`preserveCloudConnectorGeneralKey` in
  `server/src/services/instance-settings.ts`).
- Environment variables (see [../SETTINGS.md](../SETTINGS.md), section
  "CLOUD-CONNECTOR"): `MYRMIDON_CLOUD_CONNECTOR_REDIRECT_BASE` (the public
  panel base the providers return to — unset means connect start answers
  `409`), and per provider `MYRMIDON_CLOUD_<PROVIDER>_CLIENT_ID` /
  `MYRMIDON_CLOUD_<PROVIDER>_CLIENT_SECRET` (`ONEDRIVE`, `GOOGLE_DRIVE`,
  `YANDEX_DISK`) — unset means that provider cannot be connected, the rest
  keeps working.
- All three providers are registered by default (`index.ts`): OneDrive
  (Microsoft Graph), Google Drive (Drive API v3), Yandex Disk (REST v1).
  Adding a cloud means implementing the `CloudProvider` interface and
  registering it — no core changes.
- When connecting fails or access is refused, check in order: the provider is
  configured (`MYRMIDON_CLOUD_<PROVIDER>_CLIENT_ID` set) and
  `MYRMIDON_CLOUD_CONNECTOR_REDIRECT_BASE` is set; the account is connected (a
  `409` says it is not); the root slug is spelled as the owner created it; the
  agent has a grant on that root; the mode allows the operation (`ro` roots
  refuse writes); the journal shows the refusal with the boundary named.

## The Clouds screen

Settings → Clouds (`company/settings/clouds`), owner-only. It shows the
connected accounts (with a **Connect** action per provider), the roots with
their kind (`in the connected account` / `shared with us (read only)`), the
folder tree of a root, the grants (agent / caste / everyone, `ro`/`rw`), and
the journal. The screen talks only to the owner API above; the token value is
never shown.

## Limitations

- A folder shared with the connector account by another account is read-only
  by construction: an `rw` grant on a `shared` root is rejected when written
  and ignored when resolved.
- Cloud shortcuts (OneDrive `remoteItem`, Google
  `application/vnd.google-apps.shortcut`) are not followed — the entry is
  refused as "a shortcut to another location".
- Moving between cloud providers is not supported.
- Google-native documents (Docs/Sheets/Slides) cannot be downloaded — the
  refusal says to download an exported copy instead.
- Yandex Disk has no shared-folder addressing (a `shared` root is refused)
  and no search endpoint (`search` walks the granted root instead).
- One connected account per provider per company: reconnecting replaces the
  previous account record.
- Uploads, downloads and reads are bounded (200,000-byte reads, 64 MiB
  downloads, 6,000,000 characters of base64 per call).

## API surface

Base paths `/api/myrmidon/cloud-connector` (owner configuration and the agent
call) and `/api/mcp/cloud-tools` (agent MCP). Configuration calls take
`companyId` as a query parameter:

```text
GET    /api/myrmidon/cloud-connector/accounts              — owner
POST   /api/myrmidon/cloud-connector/oauth/:providerId/start — owner (returns the provider authorize URL)
GET    /api/myrmidon/cloud-connector/oauth/callback        — board (single-use state)
DELETE /api/myrmidon/cloud-connector/accounts/:id          — owner
GET    /api/myrmidon/cloud-connector/roots                 — owner; agents get their own slice
POST   /api/myrmidon/cloud-connector/roots                 — owner
DELETE /api/myrmidon/cloud-connector/roots/:id             — owner
GET    /api/myrmidon/cloud-connector/grants                — owner
PUT    /api/myrmidon/cloud-connector/grants                — owner
DELETE /api/myrmidon/cloud-connector/grants/:id            — owner
GET    /api/myrmidon/cloud-connector/tree                  — owner (folder tree of one root)
GET    /api/myrmidon/cloud-connector/journal               — owner
POST   /api/myrmidon/cloud-connector/call                  — agent tool call (access-scoped)
POST   /api/mcp/cloud-tools                                — agent MCP (JSON-RPC)
```

## Operator notes

- The divergence registry rows are CLOUD-CONNECTOR, CLOUD-CONNECTOR-B,
  CLOUD-CONNECTOR-C and CLOUD-CONNECTOR-MCP in
  [../DIVERGENCE.md](../DIVERGENCE.md); the module is
  `server/src/myrmidon/cloud-connector/`, mounted in `server/src/app.ts`; the
  screen is `ui/src/components/myrmidon/clouds/`.
- Acceptance behavior is covered by `*.myrmidon.test.ts` next to the module:
  the access model, path confinement, route authorization, the OAuth flow
  (authorize URL, PKCE, code exchange, single-use state), the token store and
  refresh (60-second skew, deduplication, version guard), the MCP surface, and
  each provider (addressing, shortcuts, search confinement, error mapping).
- The module replaces the temporary `tools/cloud-files` service (see
  [cloud-files-connector.md](cloud-files-connector.md)); path rules were
  ported so the board accepts exactly the paths that service accepted.
