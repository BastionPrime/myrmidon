# Client mail through the installed Outlook client (EXTCASE-M)

The mail path of the first third-party case. The client's mail is read **through the installed
Outlook client** on the client's PC, not through a mail-server API: this was chosen so that the
path does not depend on the type of the mail server (Microsoft 365, an on-premises Exchange,
IMAP — it makes no difference).

This document covers the **board side** of the case. The module that talks to Outlook lives in the
client's Windows connector service (Myrmidon Connector) and is documented with that service.

## 1. The two halves

```
[client PC, Windows]                                   [board]
  Myrmidon Connector (Windows service)                   client-mail (this module)
   └ mail module ── outbound channel ──────────────────►  pipeline ─ rules ─ classifier
      Outlook object model (COM/MAPI)                     │
      in the user's session                               ├ PDF attachments → recognition
      list / read / save / move / categorize / draft      ├ tender fields → JSON
                                                          └ board task → the platform bot
        ◄──────────── decision (folder or category) ──────┘
```

The connector channel is **outbound only** from the client: the client PC has no listening port.
A client is a separate company on the board — its own agents, secrets, journal and gateway key —
and the mail settings are per company too, so one client cannot read or change another's folders,
categories, rules or fallback.

## 2. What the mail module must do

The board's requests are fixed in the shared contract
(`packages/shared/src/myrmidon-client-mail.ts`) so that the pipeline can be built and tested before
the module exists. The actions:

| Action | Purpose |
|---|---|
| `mail.status` | Is Outlook running, and does it expose the COM object model? |
| `mail.list` | New mail since a watermark |
| `mail.read` | The body and metadata of one message |
| `mail.attachment.save` | The bytes of one attachment, base64 on the wire |
| `mail.move` | Put a message in a folder |
| `mail.categorize` | Add categories to a message |
| `mail.draft` | A draft that replies to a message |

An answer is `{ ok: true, result }` or `{ ok: false, error, message }`. **A refusal is data on the
wire, never a broken channel**: the operator needs to be told "Outlook is not running", and the
pipeline must not be handed a thrown transport value it would have to interpret.

### Classic Outlook only

Only the classic desktop Outlook exposes COM. The **new** Outlook does not, so no mail path exists
on such a machine. The module reports it as the status error `outlook_new_client` rather than
answering with an empty list: an operator told "no new mail" while the module can read nothing at
all would look for a defect that is not there. `describeClientMailModuleStatus` turns any status
into the one line the operator sees.

## 3. The pipeline

One item in, one decision out, plus the work the item caused.

1. **Already seen?** An item whose `messageId` was decided for this company before is skipped
   before anything else runs. A channel reconnect that re-sends a batch therefore cannot move a
   message twice or create a second board task for it.
2. **The client's rules decide first.** A message a rule matches is decided by that rule and never
   reaches a model, so the client's own sorting is reproduced exactly, costs nothing and keeps
   working when the gateway is down. Rules are tried by `priority`, ties in array order; a
   disabled rule never matches.
3. **Only what no rule claimed goes to the classifier**, and only when the company configured a
   model. The classifier is asked through the gateway (`MYRMIDON_CLIENT_MAIL_LLM_BASE_URL`, falling
   back to `MYRMIDON_BOT_LLM_BASE_URL`).
4. **The answer is validated against the configured vocabulary.** A model answer naming a folder or
   category the client did not configure is dropped and the fallback folder is used. This is what
   keeps a prompt injected into a message body from steering mail anywhere the client did not
   allow. The body a model sees is capped at the company's `maxBodyChars` (4000 by default).
5. **A failure never loses the mail.** An unreachable gateway, an off-vocabulary answer, a
   company without a classifier, a secret read hiccup: each is noted for the operator and the
   fallback decides. The fallback is the configured folder, or `keep` when none is configured.
6. **PDF attachments go to recognition** (`MYRMIDON_OCR_*`, the same variables as the OCR path of
   the case), and the tender fields found in the recognized text become a board task for the
   platform bot. A non-PDF is listed but not read; an unreadable PDF is noted and the message is
   still sorted — recognition is an addition to the mail path, not a dependency of it.
7. **The journal carries metadata only**: which rule decided, which folder or category, counts,
   attachment names and sizes. Never a message body, a subject or attachment bytes.

## 4. The tender dossier

`dossier.ts` reads the fields a person wants first out of a recognized document, without a model —
the same input gives the same answer:

```json
{
  "number": "44-ФЗ/12345",
  "deadlines": [{ "text": "Дата окончания подачи заявок: 15.10.2026", "date": "2026-10-15" }],
  "sums": [{ "text": "НМЦК: 1 500 000,00 руб.", "amount": 1500000, "currency": "RUB" }],
  "requirements": ["Участник должен предоставить обеспечение исполнения контракта."],
  "messageId": "…",
  "attachments": ["документация.pdf"]
}
```

A task is created only when the dossier carries a number, a deadline or a sum — a prose document
with none of them is not a tender. The task goes to the agent the company named in
`platformAgentId`, is created `todo`/`high`, and is keyed
`client-mail:<companyId>:<messageId>`, so even a race between two deliveries of one message cannot
double it. A tender pack with no recognized fields produces no task, and the reason is journalled.

## 5. API

Panel (board-authenticated reads, instance-admin writes):

| Route | Purpose |
|---|---|
| `GET /api/myrmidon/client-mail/settings/:companyId` | The mail settings of one client company |
| `PATCH /api/myrmidon/client-mail/settings/:companyId` | Change them; the change is journalled in that company |
| `GET /api/myrmidon/client-mail/ledger/:companyId` | How messages were decided (`?messageIds=a,b`) |
| `POST /api/myrmidon/client-mail/rules/preview/:companyId` | Try the client's rules against a sample message |

Ingestion (company-scoped, the same check as the OCR MCP endpoint, so a bot of one company cannot
feed another company's mail path):

| Route | Purpose |
|---|---|
| `POST /api/myrmidon/companies/:companyId/client-mail/batch` | Process a batch of items and get the per-item outcome |

`rules/preview` runs the **same** `mailRuleMatches` the pipeline uses: a preview that decided
differently from the pipeline would be worse than no preview.

## 6. Settings of one client company

Stored in `instance_settings.general.clientMail.companies[<companyId>]`, one entry per client
company, and carried over every vendor write of `general` the way the maintenance and stack-registry
keys are. No migration.

| Field | Meaning |
|---|---|
| `enabled` | The path is off until an operator enables it: a batch for a company whose path is not enabled is refused, and the error names this setting |
| `folders`, `categories` | The vocabulary the model may choose from, and the targets the panel offers |
| `fallbackFolder` | Where an undecided message goes; `null` means it is left alone |
| `platformAgentId` | The board agent of the client's tender bot that receives the task |
| `classifierModel` | The model the classifier asks through the gateway; `null` disables the model step |
| `classifierKeySecret` | The **name** of the company secret holding the classifier's gateway key. A name, never a value, so one client's key can never be used for another client's mail |
| `maxBodyChars` | Body characters handed to the classifier; 4000 by default |
| `rules` | The client's own rules: `match` (sender address or domain, subject, body, attachment flag, existing category — all present fields must hold) and `decision` (folder or category) |

## 7. Tests

Documented unit tests, no board and no mailbox needed:

| Suite | What it holds |
|---|---|
| `client-mail.myrmidon.test.ts` | The pipeline: rules before the model, idempotency, per-company isolation, a malformed item not losing the batch, recognition and the task, the journal keeping no body |
| `classifier.myrmidon.test.ts` | The cap on the body sent, an off-vocabulary answer, a failing status, the key in a header and never in the body |
| `dossier.myrmidon.test.ts` | The forms a Russian tender actually writes its fields in, and that the reading is deterministic |
| `packages/shared/src/myrmidon-client-mail.myrmidon.test.ts` | The shared contract: the matcher, the decision vocabulary, the module status, settings normalization |

The module's own half is tested against a fake Outlook object model in the connector service.

## 8. What is deliberately not here

- **The transport to the client PC.** `ClientMailChannel` (`channel.ts`) is the port: the request
  and answer contracts and the reading of the module's refusals exist, the connection does not. It
  belongs to the connector service part of the case; when it lands it implements `send` and the
  path starts working without a change in this module.
- **The attachment bytes**, which arrive over that same channel. Until it is wired in, an item's
  PDF is reported as unreadable and the message is still sorted.
- **The Windows service and the extension.** Separate part of the case, separate repository
  directory.
- **Personal data.** Client mail and documents carry personal data of identified persons; masking
  it before a model is a separate concern of the case, flagged to the owner.