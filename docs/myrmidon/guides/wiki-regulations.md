# Company regulations in the wiki (draft → approved, revisions, rollback)

> Russian version: [wiki-regulations.ru.md](wiki-regulations.ru.md)

A company regulation is a wiki page whose audience is a set of roles, not a
person: "how the engineers run a deploy", "what the owner approves". The board
is the single source of the rules the agents follow, and the wiki is where
those rules are written and kept.

The lifecycle is deliberately one-way in the direction that matters: **writing
text never changes what the fleet reads.** An edit — of a draft or of an
approved regulation — appends a new DRAFT revision, and the resolver keeps
answering with the newest APPROVED revision until somebody approves the new
text. A rollback is one more revision that copies an earlier one, so the
history stays append-only and a restore is itself restorable.

## What the API offers

All routes live under `/api/myrmidon/companies/:companyId/wiki-regulations`:

| Route | Who | What it does |
|---|---|---|
| `GET …` | company read | Lists every regulation page of the company (any status) with the full revision history. |
| `GET …/approved/:role` | company read | The resolver: the approved revisions that apply to `role`, as the delivery path reads them. |
| `GET …/:slug` | company read | One page with its revisions. |
| `PUT …/:slug` | company write | Saves a draft. Creates the page on first save; every later save appends a draft revision. |
| `POST …/:slug/approve` | board only | Approves the newest revision — the only way text becomes delivered. A repeated approval is a no-op. |
| `POST …/:slug/rollback` | board only | Restores an earlier revision as a new one. The new revision keeps the restored status. |

Roles are plain role keys of the company's agents; the special key `*` means
"every role". An empty roles list normalizes to `*`.

The draft write is open to agent actors of the company (the wiki maintainer
agent writes drafts); approve and rollback are board-only, because they change
what the whole fleet reads. Every mutation writes a row into the company
activity log (`wiki.regulation_draft_saved`, `wiki.regulation_approved`,
`wiki.regulation_rolled_back`).

## How a regulation reaches the agents

The delivery point is the bot profile compile
(`server/src/myrmidon/bot-containers/profile-compile.ts`, marked
`myrmidon(1.6-WIKI)`): on every reconcile tick the compile asks the resolver
for the agent's role and renders one deterministic workspace file,
`REGULATIONS.md`, beside the agent's own instruction files. The compile is
deterministic and its hash decides whether a bot restarts, so:

- same approved revisions — same bytes — no restart;
- a newly approved revision changes the hash and the bot picks the new text up
  on its next run;
- a draft edit changes nothing the fleet sees; the delivered bytes are built
  from approved revisions only.

If the agent's own instruction bundle already ships a `REGULATIONS.md`, that
one wins and the compile records a warning instead of delivering the wiki
text — the wiki never overwrites an agent's own files.

## How to add the wiki maintainer agent (the "wikipedist")

The maintainer is an ordinary agent of the company whose job is to keep the
regulation pages current: it writes DRAFT revisions through the same API, and a
board member approves them. The board does not ship the agent; this is the
operator's step (bot containers):

1. Create an agent of the company with the **role** the board uses for the
   maintainer (for example `wiki-maintainer`). The role key is what the
   regulation pages can name later.
2. Give it a free DashScope model through the LLM gateway (the 1.6 rule: new
   agents run on free models only).
3. Point its instructions at the regulation API: it may `GET` the list, `GET`
   one page, and `PUT` a draft. It must not approve or roll back — the API
   answers 403 to agent actors on those two routes, so no instruction can
   override that.
4. Approve its drafts from the board when the text is right.

The instance needs no new environment variables: the feature is always on and
has no configuration.

## Permissions

- **Read and draft** — any actor with access to the company. A regulation of
  another company is indistinguishable from a missing one (404).
- **Approve and rollback** — board actors only.

## Data and migration

One row per regulation in `myrmidon_wiki_regulations` (migration 0290,
additive: a new table with a unique `(company_id, slug)` index and a status
index). The revision history rides in the `revisions` jsonb column — one entry
per revision, oldest first, each with its own status — and the newest revision
is mirrored into the plain columns so listing the wiki does not walk the
history.
