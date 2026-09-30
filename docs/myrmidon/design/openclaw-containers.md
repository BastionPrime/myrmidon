# Containers for the OpenClaw gateway: inventory and decision (C1)

> Russian version: [openclaw-containers.ru.md](openclaw-containers.ru.md)

Revision of 29.09.2026, item C1 of the 1.3 plan. Summarizes the actual inventory
of what remained of the OpenClaw gateway by the time 1.3 was planned, and records
why containerizing the gateway is not part of 1.3. The document replaces the
"image and fleetd template design" from the original statement of the item:
there is no object to containerize, so the design degenerates into an inventory
and a decision.

## 0. Summary

- The OpenClaw runtime was fully retired before release 1.3 began: units and
  the package removed, ports free, no live processes.
- The gateway has no active consumers: the only `openclaw_gateway` adapter card
  is paused with an empty configuration; the platform has no other consumers of
  the adapter.
- The new container path (template, image contract, image allowlist) already
  covers a possible return of OpenClaw: build an image carrying the contract
  label and add it to the allowlist — no separate template is needed.
- Decision on the item: close as "gateway retired"; the fate of the remnants
  (the vendor adapter, one card) is decided by the product owner; the adapter
  code stays vendor-owned and is carried by the weekly sync without our edits.

## 1. Inventory at the time of statement (facts from live systems)

### 1.1 Runtime — retired

| What | Check | Result |
|---|---|---|
| Gateway ports (web/bridge/two service ports) | connect to each in turn | connection refused on all |
| The `openclaw` binary | PATH lookup | not found |
| `openclaw*` units | unit registry | absent |
| Gateway processes | process list | absent |
| Shared skills/tools directories | path checks | absent (moved in 1.2) |

This agrees with the closed internal decommission order: all units stopped and
removed, the package removed, the rollback path kept in the decommission
directory outside the repository.

### 1.2 Consumers in the platform

At the time of the inventory the only `openclaw_gateway` adapter card was
paused with an empty configuration (values wiped at retirement); the platform
has no other consumers of the adapter. The working fleet path is the container
adapter; host-based adapters are being retired under the 1.2–1.3 plan.

Rotation of the shared gateway token (the last class of tasks that lived on
OpenClaw) was closed with the conclusion "no consumer records remain in the
platform" — the control sign that there are no live consumers.

### 1.3 Remnants in code and repository

- The `packages/adapters/openclaw-gateway` package is vendor code, present in
  `main` without our edits; it is carried by the weekly vendor sync. It needs
  no separate maintenance.
- The vendor recipe for running OpenClaw in Docker for local development is
  `docs/guides/openclaw-docker-setup.md`; it is not a production path and stays
  as is.
- The memory of the OpenClaw era — the sqlite databases of the retired
  runtime — is compressed into the decommission archive; it has no relation to
  the container migration.
- The decommission backup (units plus a config snapshot) is kept outside the
  repository.

## 2. Why the containerization design degenerates

1. **No object.** The gateway was removed from the host; no source remains for
   an image (no package, no binary, no configuration). Building a "gateway
   image" would mean restoring the retired runtime — the opposite of the
   owner's decommission order.
2. **No consumers.** The only adapter card is paused with an empty
   configuration; a migration "with memory" is impossible and unnecessary: the
   OpenClaw-era memory is compressed into the archive.
3. **The container path is already ready for a return.** The current container
   template (fixed hermes/workspace/scratch volumes, image contract "1", the
   `MYRMIDON_BOT_IMAGE_ALLOWLIST` image allowlist, containers only from
   CI-built images) covers the "bring OpenClaw back as a container" scenario
   with no new template: build an image with the
   `myrmidon.bot-runtime.contract=1` label, add it to the allowlist, create a
   card. Additional requirements (a web-interface port, tmpfs on /tmp) will be
   recorded in the next version of the image contract when a real need arises.
4. **The item's dependency on FLEETD-B lapses.** The dependency was needed only
   to run the gateway; the inventory and the decision do not require it.

## 3. Decision and the fate of the remnants (for the owner's word)

- Item C1 "containers for the OpenClaw gateway" is closed as "gateway retired"
  — by the same formula as the 1.3 exit criteria: "runs in a container under
  fleetd if it is still in service by 1.3, or the item is closed by the owner's
  word if the gateway is retired".
- Recommendation on the remnants (the owner decides):
  - the vendor `openclaw-gateway` adapter — leave as is (vendor-owned, without
    our edits);
  - the phantom `openclaw_gateway` card — delete it or rename it into a
    memorial; it cannot be restored (the configuration is empty), it causes no
    harm, but it shows up in listings.
- The item "run the gateway under fleetd with memory carried over" (the second
  half of C1) loses its subject: it is recommended to close it by the same
  owner decision if no return of OpenClaw is planned.

## 4. Deviations from the plan

1. The statement of the item allowed both outcomes; the actual one is
   "retired". No image/template design for fleetd is required.
2. The external dependency on FLEETD-B is not required.
3. Return valve: if OpenClaw comes back, the criteria and the template are
   already in code (contract "1"); no new plan item is needed, an image in the
   allowlist is enough.

## 5. How this was verified (the "why" criterion)

- Live probes: gateway ports — connection refused; unit registry, PATH,
  process list, skills directories — empty.
- Platform: a dump of agent cards grouped by adapter; the adapter's consumer
  card is paused with an empty configuration.
- Repository: `main` (release 1.2.0) — the adapter package is present,
  vendor-owned, without edits; the container template and image contract "1"
  live in `server/src/myrmidon/bot-containers/template.ts`.
- Decision history: the closed internal decommission and rotation tasks, the
  update plan, the section "containers for the OpenClaw gateway — 1.3 or
  later".

## 6. Risks

- A return of OpenClaw after the item is closed is blocked by nothing: the
  container path is described in §2.3.
- The vendor adapter has no consumers and is not exercised on the staging
  environment; if the vendor breaks it in a refactoring, we will notice via
  the sync (the adapter tests run in the vendor's CI).
- The phantom card can confuse a new operator — the removal recommendation is
  in §3.
