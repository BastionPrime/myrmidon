# OCR path: PDF to text in the bot workspace

> Russian version: [ocr.ru.md](ocr.ru.md)

The OCR path turns a PDF a bot received — a mail attachment, a file downloaded
through the [browser bridge](bridge-extension.md), a document in its workspace
— into text the bot can work with, plus a structural excerpt for tender
documentation (requirements, deadlines, positions). The recognized text goes to
the workspace; the activity journal sees only metadata.

## What a bot calls

The bot-facing tool is **`ocr.pdf`**, served over JSON-RPC at the company
endpoint `POST /api/myrmidon/companies/:companyId/ocr/mcp` (`initialize`,
`tools/list`, `tools/call`; `server/src/myrmidon/ocr/`).

Input: `name` (the file name — it names the workspace file and the journal
entry), `base64` (the PDF; a `data:` URL prefix is tolerated), optional
`origin` (`mail_attachment` / `browser_download`) and `sourceId`.

Output: `text`, `pages`, `structure`, `metadata`. A failed recognition comes
back as a **tool result with `isError`** and a stable code in
`structuredContent.code` — not a transport error — so the bot can decide (try a
different file, report to its operator) instead of retrying blindly.

Error codes: `ocr_disabled`, `not_a_pdf`, `document_too_large`,
`too_many_pages`, `empty_document`, `backend_failed`, `workspace_write_failed`,
`journal_failed`, `invalid_tool_input`.

## Where the text lands

The full text is returned in the tool result. When
`MYRMIDON_OCR_WORKSPACE_DIR` is set, a copy is written there as
`<name>-<hash>.txt` (mode 0600, the hash covers name and content so a second
document never overwrites the first). Without the setting the text lives only
in the tool response — a container bot writes it into its workspace itself.

The journal (`activity_log`) gets one row with metadata only: `name`,
`sizeBytes`, `pages`, `origin`, `sourceId`, `backend`, `chars`, `truncated`.
**The text and the PDF bytes never enter the journal.**

## Backends

Selected by `MYRMIDON_OCR_BACKEND`:

- `ragflow` (default) — MCP JSON-RPC `tools/call` to a RAGFlow server (DeepDOC
  parsing); `MYRMIDON_OCR_MODEL` names the parsing tool
  (`parse_document` by default).
- `litellm` — an OpenAI-compatible chat request to the shared gateway with the
  PDF as a file part; `MYRMIDON_OCR_MODEL` names the model and is **required**
  — without it the profile is not assembled and calls answer `ocr_disabled`.

An unknown backend value falls back to `ragflow` (a typo must not close the
path).

## Limits and switches

All limits refuse **before** the backend is contacted — and the size refusal
happens before the base64 payload is decoded:

| Setting | Default | Refusal |
|---|---|---|
| `MYRMIDON_OCR_BASE_URL` | unset | unset — the path is closed: every call answers `ocr_disabled`, no request goes out |
| `MYRMIDON_OCR_KEY_SECRET` | unset | name of the company secret with the contour key; unset — path closed |
| `MYRMIDON_OCR_MAX_BYTES` | 32 MiB | `document_too_large` |
| `MYRMIDON_OCR_MAX_PAGES` | 500 | `too_many_pages` |
| `MYRMIDON_OCR_MAX_CHARS` | 2 000 000 | the rest is cut; `metadata.truncated: true` |
| `MYRMIDON_OCR_TIMEOUT_SEC` | 120 | backend request timeout (5–600) |

Full table and operator notes: [../SETTINGS.md](../SETTINGS.md). The OCR
contour key is a **company secret** named by `MYRMIDON_OCR_KEY_SECRET`; the
value is read per call for the task's owning company and never appears in the
setting, logs or journal.

## Related

- [../SETTINGS.md](../SETTINGS.md) — every `MYRMIDON_OCR_*` variable.
- [bridge-extension.md](bridge-extension.md) — how a PDF arrives through the
  browser bridge.
- [cloud-files-connector.md](cloud-files-connector.md) — mail attachments as
  an OCR source.
