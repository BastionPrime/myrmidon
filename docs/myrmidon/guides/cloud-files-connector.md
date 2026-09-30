# Microsoft 365 files and mail for container bots

> Russian version: [cloud-files-connector.ru.md](cloud-files-connector.ru.md)

The `tools/cloud-files` service gives container bots access to OneDrive and a
shared mailbox of one service Microsoft account (a personal account, tenant
`consumers`). The image is built by the workflow
`.github/workflows/myrmidon-cloud-files.yml` and published as
`ghcr.io/itkadr-git/myrmidon-cloud-files`; on production it is pinned by the
CI-built digest. The detailed reference is
[../cloud-files.md](../cloud-files.md).

## How a bot reaches the service

```
bot ──▶ the board tool gateway (bearer + x-paperclip-agent-id) ──▶ cloud-files:8080/mcp ──▶ Microsoft Graph
bot ──▶ cloud-files:8080/v1/files  (large files; identity by the container name in docker DNS)
```

The Microsoft token lives only in the service (`/state/token.json`, mode 0600)
and is refreshed inside it; the bot never sees it. The mailbox owner signs in
once with a device-code flow.

## What the bot can do

The bot addresses data by `(root, path)`. Item ids are never accepted. Roots and
permissions are set per bot in `config/bots.json` (see
`config.example.json`):

- `shared` — a folder shared with the service account, read only;
- `own` — a folder in the account's own drive, with `ro`/`rw` per bot;
- a mail mode per bot: `none`, `read` or `send`.

`..`, OneDrive shortcuts and anything outside the root are refused; write to a
shared root is rejected at config load.

The tools: `cloud_whoami`, `drive_list`, `drive_search`, `drive_read_text`,
`drive_download`, `drive_upload`, `drive_mkdir`, `drive_move`, `stage_list`,
`stage_delete`, `mail_list`, `mail_search`, `mail_read`,
`mail_attachment_download`, `mail_send` (a per-bot send limit of 30 messages per
hour).

Large files go through a per-bot staging area (TTL 12 hours, a quota): the bot
downloads with `drive_download`, then fetches the file from
`/v1/files/<id>`; it uploads with a `PUT` to `/v1/files?name=…` and then
`drive_upload(file_id=…)`. One bot's staged files are not visible to another.

## Setting the service up (administrator)

1. Put the container on the `myrmidon-bots` network only; publish no ports.
   A compose example is in `compose.example.yml`.
2. Create `config/bots.json` from `config.example.json`: name the roots and set
   each bot's `ro`/`rw` roots and mail mode. The bot key is the board agent id.
3. Sign in once as the mailbox owner:

   ```sh
   docker compose exec -d cloud-files python -m cloud_files auth
   ```

   The link and device code appear in `/state/devicecode.json` (not a secret).
   The requested scopes are `Files.ReadWrite.All Mail.ReadWrite Mail.Send
   offline_access User.Read`.
4. Connect the board to the service as an `mcp_http` application: a connection
   of type `mcp_remote` to `http://cloud-files:8080/mcp` with the bearer from a
   secret and `headerPolicy.metadata.forward = ["agent_id"]`.

## Audit

Every call is journaled to `/state/audit.log` as JSON lines: bot, tool, root,
path, outcome. File contents and mail subjects or bodies are not logged.
