# Access hub

> Russian version: [access-hub.ru.md](access-hub.ru.md)

Access hub is a settings section (Settings → Access hub, route
`company/settings/access-hub`, sidebar entry right after Secrets) for the
secrets agents, hosts and services use: who holds a credential, where it is
used, when it was last rotated.

The section rides the operator visibility key of Secrets: the entry appears in
the settings sidebar only where the Secrets page itself is visible.

## Current state of the rollout

Read this section before anything else — it describes what the merged code
actually does today.

The section ships in two parts that landed with **different wire contracts**:

- The UI (the screen, list, card and dialogs) calls
  `POST /secrets`, `POST /secrets/generate-ssh`, `POST /accesses/:id/grant`,
  `POST /accesses/:id/revoke`, `POST /accesses/:id/rotate`, `PUT /hosts` and
  `GET /audit` under `/api/myrmidon/access-hub`, and expects the access list
  as a bare array.
- The server module serves a different surface under the same prefix:
  `POST /secrets/generate-ssh-key`, `POST /secrets/:id/rotate-ssh-key`,
  `POST /secrets/:id/kind`, path-less `POST /accesses/grant` and
  `POST /accesses/revoke`, `GET /secrets/:id/bindings`, `GET /journal`, full
  host-registry CRUD and `GET /status`, and wraps the access list in an
  object (`{ enabled, accesses, hosts }`).

As a result, on an instance that runs this server module the screen does not
fall into the "not available yet" notice (the availability probe treats only
404/501 as "no API here"), but the list call returns a shape the page does not
expect and every mutating control calls a route the server does not implement.
The end-to-end flows described below are therefore **not operational yet**;
they document what each control is for. The server API itself, called
directly with its own routes, works behind the feature flag.

Two more rollout facts:

- The server module sits behind `MYRMIDON_ACCESS_HUB_ENABLED` (default `false`;
  see [SETTINGS.md](../SETTINGS.md)). While the flag is off, read endpoints
  answer `enabled: false` with empty payloads and never touch the storage, and
  mutating endpoints refuse with 409 (`access_hub_disabled`).
- Laying an SSH key out on a host is a fake deploy port for now: the server
  records the host set on the secret's metadata and journals the operation,
  but no real SSH connection is made (the real client is a later part). Only
  the public half of a key is ever meant to reach a host.

## The one secrecy rule

Secret values are never displayed. The list, the card and the journal render
names, references, versions and the public SSH fingerprint only — there is no
value column anywhere in the section. The single piece of credential material
the UI ever shows is the public half of an SSH key pair the operator has just
generated: it is held in the page's memory while that card (or the generation
dialog) stays open, and reopening the card shows the fingerprint alone. A
value typed into a write dialog is sent once, never echoed back by the API and
cleared from the form as soon as the save resolves.

The same rule holds on the server: list and journal responses carry no value
field, the private half of a generated key goes into the existing company
secrets storage through the existing create/rotate path and never leaves it
through an access-hub response, and the public half is returned exactly once —
in the generation (or key rotation) response.

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
- **Generate new key** — for SSH accesses, generate a new key pair (see below).
- **Deploy to hosts** / **Withdraw from hosts** — change the set of fleet hosts
  that hold this access.
- **Grant** / **Revoke** — hand the access to an agent or take it back. A grant
  is a reference: the agent receives access to the secret, not a copy of its
  value. On the server a grant is a row in the existing secrets binding table
  (`targetType: "agent"`, `configPath: "env"`), resolved into the agent's
  container environment by the existing profile compiler.

## Rotation

The rotate dialog has two modes:

- **External source** — the value changed outside Myrmidon; a new version is
  recorded without a typed value.
- **New value** — type the new value; it is written once and never echoed.

Both modes offer "Restart the containers that use this access" (on by
default), so each restarted container picks up the new value, and the result
toast reports the new version number and the restarted containers.

Note under the current rollout state: the merged server implements rotation
for SSH keys (`POST /secrets/:id/rotate-ssh-key` — a fresh pair is generated,
the private half becomes the new version, the new public half is returned
once). The generic rotate route the dialog calls (`POST /accesses/:id/rotate`)
and the container restart it offers are not in the merged server yet.

## SSH key generation

The generate dialog creates a new SSH key pair as an access. Give the key a
name and optionally pick hosts from the fleet host registry.

On the server, generation creates an ed25519 pair: the private half becomes
the value of a new secret through the existing create path, the public half
and its fingerprint (`SHA256:…`, the OpenSSH form) come back once in the
response, and the chosen hosts are recorded on the secret's metadata. The
public half and its fingerprint are shown once, in this dialog — copy the
public key to every selected host now. Only the fingerprint survives on the
card afterwards; reopening the card shows the fingerprint alone.

## Journal

The Journal tab lists who touched which access, when, and which version came
out of it: creating, granting, revoking, rotating and deploying accesses all
land here. Journal lines carry names and versions — never values. The tab
shows the newest 50 lines.

On the server the journal is the activity log filtered to the `access_hub.*`
actions, newest first, with a default limit of 100 entries (maximum 500).

## API

The server module serves `/api/myrmidon/access-hub/*`, board-only, behind
`MYRMIDON_ACCESS_HUB_ENABLED`:

| Route | Purpose |
|---|---|
| `GET /status` | Whether the module is enabled on this instance |
| `GET /accesses` | Access list with host registry: `{ enabled, accesses, hosts }` |
| `POST /secrets/generate-ssh-key` | Generate an ed25519 SSH key pair as a new secret; the public half is returned once |
| `POST /secrets/:id/rotate-ssh-key` | Rotate an SSH-key secret to a fresh pair; the new public half is returned once |
| `POST /secrets/:id/kind` | Set the secret's kind (`ssh_key` / `password` / `token` / `oauth`) and SSH metadata |
| `POST /accesses/grant` | Grant a secret to an agent (body: `secretId`, `agentId`) |
| `POST /accesses/revoke` | Revoke a secret from an agent (same body) |
| `GET /secrets/:id/bindings` | The bindings of one secret (who holds it) |
| `PUT /accesses/:id/hosts` | Set the host set of an SSH-key secret (deploy/withdraw is one set-shaped write) |
| `GET /journal` | Journal entries, newest first (`limit` query, default 100, max 500) |
| `GET /hosts`, `POST /hosts`, `PATCH /hosts/:hostId`, `DELETE /hosts/:hostId` | Fleet host registry (instance-wide, at most 200 hosts) |
| `POST /hosts/:hostId/deploy/:secretId` | Deploy one SSH key to one host (fake deploy port for now) |

Paths carry no `:companyId`: the company comes from the `companyId` query
parameter first, then from the caller's single active company membership;
zero or several memberships without the parameter answer 422.

Secret values never travel back over this API: records carry no value field,
and the one write-only value the operator types is never echoed in a response.

## Questions and answers

**I lost a value. Can I read it back?**
No — by design. No list, card, journal or API response carries a value. Set a
new value on the card (**Change value**) or, for SSH keys, rotate to a fresh
pair; then restart the consumers so they pick up the new version. (Under the
current rollout state these controls are the ones still waiting on the wire
contract — see above.)

**How do I check that an agent picked an access up?**
A grant is a binding row (`targetType: "agent"`, `configPath: "env"`), and the
grant lands in the journal (`access_hub.access.granted`). The value reaches
the agent's container environment through the existing profile compiler at
container start; a container started before the grant keeps running without it
until its next start.

**What does the "soon" badge on the settings entry mean?**
The access-hub API answered 404 or 501 — this instance does not serve the
module's routes at all. The screen shows one "not available yet" notice in
that case and turns on by itself once the server part is deployed. Note the
probe only recognises a missing route; with the module deployed but the
feature flag off, the badge does not appear.
