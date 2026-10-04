#!/usr/bin/env bash
# scripts/myrmidon/release/publish-github-release.sh
#
# RELEASE-PUBLISH (the 02.10 gap): every myr-vX.Y.Z tag gets its GitHub
# Release automatically. On 02.10 the tag myr-v1.5.0 existed for 40 minutes
# and the board ran 1.5.0, but GitHub still showed 1.4.0 as Latest because
# nobody had run `gh release create` by hand.
#
# Called by .github/workflows/myrmidon-release.yml. Inputs:
#   --tag myr-vX.Y.Z   the release tag to publish (the workflow passes the
#                      pushed tag, or the tag input of a workflow_dispatch
#                      re-run; the tag must already exist on origin)
#
# Fail-closed and idempotent:
#   1. Resolve the tag's commit (annotated tags dereferenced).
#   2. GATE: require a successful "Myrmidon CI" run and a successful
#      "Myrmidon image" (board) run for THIS tag (runs are matched by
#      head_branch == the tag — the same commit's main-branch runs build
#      different image tags and must not satisfy the gate, OPE-4271); a
#      failed run exits 1 BEFORE anything is published. Dockergate and
#      fleetd are paths-filtered workflows, so their tag run may
#      legitimately be absent — but their digests must exist in the registry
#      (step 3) or the publish is refused (fail-closed, the RELEASE-GATE
#      contract). Runs still in progress are waited for (the image
#      workflows start alongside this workflow on a
#      tag push).
#   3. Build the body with scripts/myrmidon/release/release-body.mjs: the
#      `## X.Y.Z` section of docs/myrmidon/CHANGELOG.md (missing = a release
#      without notes = defect, exit 1), the deploy line + "Upgrading from …"
#      link, and the component digest table from the registry.
#   4. `gh release create --latest`; when the release exists, `gh release
#      edit` (idempotent re-run).
#   5. Mark the previous minor/patch release title "(superseded)" (the manual
#      convention of 1.3.x/1.4.0).
#
# Uses only GITHUB_TOKEN (contents: write). Nothing host- or deployment-
# specific enters the body: the public repository rules (CONVENTIONS section
# 9) apply to the body exactly as to a committed file.

set -euo pipefail

usage() {
  sed -n '2,37p' "$0"
  exit 0
}

die() { printf '[myrmidon-release-publish] ERROR: %s\n' "$*" >&2; exit 1; }
log() { printf '[myrmidon-release-publish] %s\n' "$*" >&2; }

tag=""
while (($#)); do
  case "$1" in
    --tag) tag="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) die "unknown argument: $1" ;;
  esac
done

command -v gh >/dev/null 2>&1 || die "gh is not installed"
command -v jq >/dev/null 2>&1 || die "jq is not installed"

[[ "$tag" =~ ^myr-v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "tag must look like myr-vX.Y.Z (got: $tag)"
version="${tag#myr-v}"
repo="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is not set}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ------------------------------------------------------------- 1. the tag ----
ref_json="$(gh api "repos/$repo/git/ref/tags/$tag" 2>/dev/null)" \
  || die "tag $tag not found on origin"
object_type="$(jq -r '.object.type' <<<"$ref_json")"
object_sha="$(jq -r '.object.sha' <<<"$ref_json")"
if [[ "$object_type" == "tag" ]]; then
  # Annotated tag: the ref points at the tag object; dereference to the commit.
  gh api "repos/$repo/git/tags/$object_sha" --jq '.object.sha' > "$here/.tag-commit" 2>/dev/null \
    || die "could not resolve the commit of annotated tag $tag"
  # --jq prints a JSON string: strip the quotes to get the bare sha.
  sha="$(sed -e 's/^"//' -e 's/"$//' "$here/.tag-commit")"
  rm -f "$here/.tag-commit"
else
  sha="$object_sha"
fi
log "tag $tag -> commit $sha"

# ------------------------------------------------------------- 2. CI gate ----
# Completed-run verdict of one workflow for THIS tag: prints "missing"
# when no completed run exists, else the unique conclusion, else "mixed"
# (at least two different conclusions — a failed attempt exists, fail closed).
#
# OPE-4271: runs are selected by head_branch == the tag, not just by head_sha.
# The release commit normally lands on main BEFORE the tag is pushed, so the
# API also answers with the main-branch runs of the same commit; those build
# the `main`/`sha-<short>` image tags, not the `myr-vX.Y.Z` version tag this
# release publishes. Matching them made the publish skip the wait (1.6.1:
# the main image run was green, the tag image run was still building, and
# the digest probe then failed with "component image digests missing").
run_verdict() {
  local workflow_file="$1" verdict
  verdict="$(gh api --paginate "repos/$repo/actions/runs?head_sha=$sha&per_page=100" \
    --jq "[.workflow_runs[]? | select(.path == \"$workflow_file\" and .head_branch == \"$tag\")]
          | map(select(.status == \"completed\"))
          | if length == 0 then \"missing\"
             else (map(.conclusion) | unique)
                  | if length == 1 then .[0] else \"mixed\" end end" 2>/dev/null)" \
    || verdict="missing"
  # gh --jq prints a JSON string: strip the quotes to get the bare value.
  printf '%s\n' "${verdict//\"/}"
}

# Status of the newest run (any state) of one workflow for THIS tag.
run_status() {
  local workflow_file="$1" status
  status="$(gh api --paginate "repos/$repo/actions/runs?head_sha=$sha&per_page=100" \
    --jq "[.workflow_runs[]? | select(.path == \"$workflow_file\" and .head_branch == \"$tag\")][0].status // \"missing\"" \
    2>/dev/null)" \
    || status="missing"
  printf '%s\n' "${status//\"/}"
}

# Poll cadence of the gate wait. Overridable for the tests (the default is
# sized for CI: image workflows on a tag push run up to ~40 minutes).
POLL_SECONDS="${MYRMIDON_RELEASE_POLL_SECONDS:-20}"
POLL_MAX="${MYRMIDON_RELEASE_POLL_MAX:-120}"

# wait_for <workflow_file> <must|soft> <label>
#   must — a completed run must exist and be success; a missing/failed run
#          refuses the publish.
#   soft — no completed run is acceptable (paths-filtered); a failed one is
#          not (it means this release's component build broke).
wait_for() {
  local workflow_file="$1" need="$2" label="$3" verdict status polled=0
  while ((1)); do
    verdict="$(run_verdict "$workflow_file")"
    if [[ "$verdict" != "missing" ]]; then
      break
    fi
    status="$(run_status "$workflow_file")"
    if [[ "$status" == "missing" ]]; then
      if [[ "$need" == "soft" ]]; then
        log "gate: no run of $label for $sha (paths-filtered) — accepted"
        return 0
      fi
      if ((polled >= POLL_MAX / 2)); then
        die "no run of $label found for commit $sha after $polled polls — refusing to publish"
      fi
    fi
    ((polled >= POLL_MAX)) && die "timed out waiting for $label runs on $sha after $polled polls"
    sleep "$POLL_SECONDS"
    polled=$((polled+1))
  done
  if [[ "$verdict" != "success" ]]; then
    if [[ "$need" == "must" ]]; then
      die "$label did not succeed for commit $sha (conclusion: $verdict) — NOT publishing. A release whose CI failed must not exist."
    fi
    die "$label failed for commit $sha (conclusion: $verdict) — NOT publishing."
  fi
  log "gate: $label success for $sha"
}

log "gate: Myrmidon CI on $sha"
wait_for ".github/workflows/myrmidon-ci.yml" must "Myrmidon CI"
log "gate: Myrmidon image (board) on $sha"
wait_for ".github/workflows/myrmidon-image.yml" must "Myrmidon image (board)"
log "gate: Myrmidon dockergate image on $sha"
wait_for ".github/workflows/myrmidon-dockergate.yml" soft "Myrmidon dockergate image"
log "gate: Myrmidon fleetd image on $sha"
wait_for ".github/workflows/myrmidon-fleetd.yml" soft "Myrmidon fleetd image"

# ------------------------------------------------------ 3. the release body --
# release-body.mjs exits 1 when the CHANGELOG section or any component
# digest is missing — the script then dies before publishing anything.
# --registry-state (offline digest simulation) is for tests; CI resolves the
# digests from the live registry.
body_args=()
if [[ -n "${MYRMIDON_RELEASE_REGISTRY_STATE:-}" ]]; then
  body_args+=(--registry-state "$MYRMIDON_RELEASE_REGISTRY_STATE")
fi
node "$here/release-body.mjs" "${body_args[@]}" "$version" > release-body.md \
  || die "release body could not be built for $version (missing notes or component digests)"
log "release body built ($(wc -c < release-body.md) bytes)"

# -------------------------------------------------------- 4. publish --------
title="Myrmidon $version"
if gh release view "$tag" --repo "$repo" >/dev/null 2>&1; then
  log "release $tag already exists — updating (idempotent re-run)"
  gh release edit "$tag" --repo "$repo" --title "$title" --latest \
    --notes-file release-body.md
else
  gh release create "$tag" --repo "$repo" --title "$title" --latest \
    --notes-file release-body.md
fi

# ----------------------------------------------- 5. supersede the previous --
# The manual convention for 1.3.x/1.4.0: the previous minor/patch release's
# title gains "(superseded)". Idempotent: no-op when the marker is already
# there. The previous version is derived from the tag the same way the body
# builder derives it.
prev_version="$(node "$here/release-body.mjs" --previous "$version")"
if [[ -n "$prev_version" ]]; then
  prev_tag="myr-v$prev_version"
  prev_title="$(gh release view "$prev_tag" --repo "$repo" --json name --jq '.name' 2>/dev/null || true)"
  if [[ -n "$prev_title" ]] && ! grep -qi 'superseded' <<<"$prev_title"; then
    gh release edit "$prev_tag" --repo "$repo" --title "$prev_title (superseded)"
    log "marked $prev_tag title '(superseded)'"
  else
    log "previous release $prev_tag not found or already superseded — no rename"
  fi
fi

log "published release $tag ($title) — body from CHANGELOG section $version + digest table"
