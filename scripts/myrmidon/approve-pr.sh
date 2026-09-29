#!/usr/bin/env bash
# Maintainer approval of a pull request head commit.
#
#   approve-pr.sh [--repo OWNER/REPO] [--dry-run] <pr-number> [key-file]
#
# Reads the head commit of the PR through gh, signs "<owner/repo>#<pr>@<sha>" with
# HMAC-SHA256 using the approval key, and posts the comment
#
#   maintainer-approval: <sha40> <hmac-hex64>
#
# which the "maintainer approval" status check (workflow myrmidon-maintainer-approval.yml)
# verifies against the repository secret MAINTAINER_APPROVAL_KEY.
#
# The key file is given as the second argument or in MYRMIDON_APPROVAL_KEY_FILE. It must be a
# regular file with mode 0600 (or 0400). CR and LF characters in it are ignored, so a trailing
# newline does not matter. The key is never printed and never appears in the arguments of any
# process: the HMAC is assembled from plain SHA-256 (RFC 2104) with the key and the pads passed
# through shell builtins and pipes only, because "openssl dgst -hmac <key>" would expose the key
# in the process list.
#
# --dry-run prints the comment instead of posting it.
set -euo pipefail

usage() {
  sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

die() {
  echo "approve-pr: $*" >&2
  exit 1
}

dry_run=0
positional=()
while (($#)); do
  case "$1" in
    --repo)
      (($# >= 2)) || usage
      export GH_REPO="$2"
      shift 2
      ;;
    --dry-run)
      dry_run=1
      shift
      ;;
    -h | --help) usage ;;
    -*) usage ;;
    *)
      positional+=("$1")
      shift
      ;;
  esac
done
((${#positional[@]} >= 1 && ${#positional[@]} <= 2)) || usage

pr="${positional[0]}"
[[ "$pr" =~ ^[1-9][0-9]{0,8}$ ]] || die "PR number must be a positive integer"
key_file="${positional[1]:-${MYRMIDON_APPROVAL_KEY_FILE:-}}"
[[ -n "$key_file" ]] || die "no key file: pass it as the second argument or set MYRMIDON_APPROVAL_KEY_FILE"
[[ -f "$key_file" && ! -L "$key_file" ]] || die "key file is not a regular file"
mode="$(stat -c '%a' "$key_file" 2>/dev/null || stat -f '%Lp' "$key_file")"
[[ "$mode" == "600" || "$mode" == "400" ]] || die "key file must have mode 0600 (found $mode)"

command -v gh >/dev/null || die "gh is required"
command -v openssl >/dev/null || die "openssl is required"

# Key bytes as a shell string: CR/LF removed, must not be empty.
key="$(tr -d '\r\n' <"$key_file")"
[[ -n "$key" ]] || die "key file is empty"

hex_of() { od -An -v -tx1 | tr -d ' \n'; }
hex_to_bin() {
  local h="$1" i
  for ((i = 0; i < ${#h}; i += 2)); do
    # shellcheck disable=SC2059  # the format is built from validated hex digits only
    printf "\\x${h:i:2}"
  done
}

# HMAC-SHA256(key, message) as lower-case hex. Block size of SHA-256 is 64 bytes.
hmac_sha256() {
  local message="$1" keyhex ipad="" opad="" i b inner
  keyhex="$(printf '%s' "$key" | hex_of)"
  if ((${#keyhex} > 128)); then
    keyhex="$(printf '%s' "$key" | openssl dgst -sha256 -binary | hex_of)"
  fi
  while ((${#keyhex} < 128)); do keyhex+="00"; done
  for ((i = 0; i < 128; i += 2)); do
    b=$((16#${keyhex:i:2}))
    ipad+="$(printf '%02x' $((b ^ 0x36)))"
    opad+="$(printf '%02x' $((b ^ 0x5c)))"
  done
  inner="$({ hex_to_bin "$ipad"; printf '%s' "$message"; } | openssl dgst -sha256 -binary | hex_of)"
  { hex_to_bin "$opad"; hex_to_bin "$inner"; } | openssl dgst -sha256 -hex | awk '{print $NF}'
}

repo="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
[[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die "cannot determine the repository (use --repo OWNER/REPO)"
repo_lc="$(printf '%s' "$repo" | tr '[:upper:]' '[:lower:]')"

state="$(gh pr view "$pr" --json state --jq .state)"
[[ "$state" == "OPEN" ]] || die "PR #$pr is not open (state: $state)"
sha="$(gh pr view "$pr" --json headRefOid --jq .headRefOid | tr '[:upper:]' '[:lower:]')"
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || die "cannot read the head commit of PR #$pr"

mac="$(hmac_sha256 "${repo_lc}#${pr}@${sha}")"
[[ "$mac" =~ ^[0-9a-f]{64}$ ]] || die "HMAC computation failed"
comment="maintainer-approval: ${sha} ${mac}"

if ((dry_run)); then
  echo "$comment"
  exit 0
fi
gh pr comment "$pr" --body "$comment" >/dev/null
echo "approved ${repo}#${pr} at ${sha:0:7}; the status check updates within a minute"
