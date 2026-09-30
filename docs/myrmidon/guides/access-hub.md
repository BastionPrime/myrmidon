# Access hub

> Russian version: [access-hub.ru.md](access-hub.ru.md)

Access hub is a settings section (Settings → Access hub, route
`company/settings/access-hub`, sidebar entry right after Secrets) that gives
the operator a fleet view of the secrets agents, hosts and services use: who
holds a credential, where it is used, when it was last rotated. From the same
screen the operator creates secrets, changes their values, grants and revokes
agent access, rotates secrets with container restart, generates SSH keys and
reads the journal.

The section rides the operator visibility key of Secrets: the entry appears in
the settings sidebar only where the Secrets page itself is visible.

## The one secrecy rule

Secret values are never displayed. The list, the card and the journal render
names, references, versions and the public SSH fingerprint only — there is no
value column anywhere in the section. The single piece of credential material
the UI ever shows is the public half of an SSH key pair the operator has just
generated: it is held in the page's memory while that card (or the generation
dialog) stays open, and reopening the card shows the fingerprint alone. A
value typed into a write dialog is sent once, never echoed back by the API and
cleared from the form as soon as the save resolves.

## Access list

The list shows every access the server reports, one row per access:

| Column | Content |
|---|---|
| Name | Access name and key |
| Type | `SSH key`, `Password`, `Token` or `OAuth` |
| Granted to | Agents that hold the access |
| Used by | Hosts and services that use it |
| Created | Creation time (UTC) |
| Rotated | Last rotation time (UTC), `—` if never |
| Version | Current version number, `v<N>` |

The list filters by free-text search (name, key, grantee and usage names), by
type and by the agent the access is granted to.

## Access card

Opening a row shows the card with the full picture of one access: version,
creation and last-rotation times, the public SSH fingerprint for keys, the
agents the access is granted to, the hosts and services that use it (with the
configuration path where the reference sits), and the host set. The card has
no value field.

Actions on the card:

- **Change value** — replace the secret's value. The new value is typed into a
  dialog, sent once and never shown back.
- **Rotate** — rotate the access (see below).
- **Generate SSH key** — for SSH accesses, generate a new key pair (see below).
- **Deploy to hosts** / **Withdraw from hosts** — change the set of fleet hosts
  that hold this access.
- **Grant** / **Revoke** — hand the access to an agent or take it back. A grant
  is a reference: the agent receives access to the secret, not a copy of its
  value.

## Rotation with restart

The rotate dialog has two modes:

- **External source** — the value changed outside Myrmidon; the server records
  a new version without a typed value.
- **New value** — type the new value; it is written once and never echoed.

Both modes offer "Restart the containers that use this access" (on by
default). Affected containers are restarted one after another in a short
maintenance window, and each restarted container picks up the new value. The
result toast reports the new version number and the names of the restarted
containers.

## SSH key generation

The generate dialog creates a new SSH key pair as an access. Give the key a
name and optionally pick hosts from the fleet host registry: generating and
deploying are one step, and the selected hosts receive the new public key with
the same call.

The public half and its fingerprint are shown once, in this dialog — copy the
public key to every selected host now. Only the fingerprint survives on the
card afterwards; reopening the card shows the fingerprint alone. Only the
public half of an SSH key ever reaches a host.

## Journal

The Journal tab lists who touched which access, when, and which version came
out of it: creating, granting, revoking, rotating and deploying accesses all
land here. Journal lines carry names and versions — never values. The tab
shows the newest 50 lines.

## API

The section talks to the access-hub API at `/api/myrmidon/access-hub`
(`GET /accesses`, `POST /secrets`, `POST /secrets/generate-ssh`,
`POST /accesses/:id/grant`, `POST /accesses/:id/revoke`,
`POST /accesses/:id/rotate`, `PUT /accesses/:id/hosts`, `GET /hosts`,
`PUT /hosts`, `GET /audit`). Secret values never travel back over this API:
records carry no value field, and the one write-only value the operator types
is never echoed in a response. Deploy and withdraw write the record's host set
through `PUT /accesses/:id/hosts`, next to the host registry the API exposes.
