# Agent instructions: revision history and restore

> Russian version: [agent-instructions-revisions.ru.md](agent-instructions-revisions.ru.md)

Every change to an agent's instructions bundle — a file put, a file delete,
a bundle patch — is snapshotted into the `agent_instructions_revisions` table
(migration 0288). The snapshot holds the whole bundle (all files with their
contents, the entry file, the source of the change, the author), not a delta.
Any earlier revision can be restored through the API; the restore itself
becomes a new revision, so the history stays append-only.

## What the API offers

All routes live under `/api/agents/:id/instructions-revisions`:

| Route | What it does |
|---|---|
| `GET /api/agents/:id/instructions-revisions` | Lists the agent's revisions, newest first. Default page size is 50. |
| `GET /api/agents/:id/instructions-revisions/:revisionId` | Returns one revision's summary (number, entry file, changed files, source, author, created at). |
| `GET /api/agents/:id/instructions-revisions/:revisionId/files` | Returns the revision's full file set (path + content). |
| `POST /api/agents/:id/instructions-revisions/:revisionId/rollback` | Restores the revision's files onto the agent's bundle. |

The summary shape (`revisionSummary`) carries: `id`, `revisionNumber`,
`entryFile`, `fileCount`, `changedFiles`, `source`, `createdByAgentId`,
`createdByUserId`, `rolledBackFromRevisionId`, `createdAt`.

## How a revision is recorded

The recording is wired into the vendored instructions routes
(`server/src/routes/agents.ts`, marked `myrmidon(H2)`):

- `PUT /api/agents/:id/instructions-bundle/file` → source
  `instructions_bundle_file_put`
- `DELETE /api/agents/:id/instructions-bundle/file` → source
  `instructions_bundle_file_delete`
- `PATCH /api/agents/:id/instructions-bundle` → source
  `instructions_bundle_patch`
- rollback → source `rollback`

Revision numbers are allocated in a transaction with a row lock on the agent
(`select ... for update`), so two concurrent edits cannot take the same
number. An empty file set is not recorded. A failure to record is logged as a
warning and never fails the edit itself.

## How rollback works

`POST .../rollback` restores the whole snapshot through the vendored
`materializeManagedBundle` (managed-bundle mode only). It rewrites the bundle
files on disk and heals the agent's `adapterConfig` to point at the managed
root. The restore is then itself recorded as a new revision with
`source: "rollback"` and `rolledBackFromRevisionId` set to the restored
revision — the history stays append-only and the restore is itself
reversible.

An external bundle cannot be rolled back: the route answers 422 with the
message to switch the agent to a managed bundle first.

The run request keeps reading the bundle files from disk (W2a/G4), so a
restored revision reaches the next run without any delivery change.

## Permissions

The routes follow the same rules as the vendored instructions-bundle routes:

- **Read** — any caller with read access to the agent's company. An agent of
  another company is indistinguishable from a missing one (404).
- **Rollback** — the same protected-change gate as the vendored bundle write:
  board actors with the `agents:configure` grant pass directly; agent actors
  fall back to the change-consent gate. When the bundle is external, the
  caller must be an instance admin.

## Activity log

Every rollback writes a row to the company's activity log with the action
`agent.instructions_revision_rollback`. The row carries the restored revision
id and number, the new revision id, and the file count.
