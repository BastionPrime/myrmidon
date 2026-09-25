# Contributing to wellmagram

## Workflow

1. Every change starts with a ticket in the project tracker.
2. The team lead breaks it down and assigns an engineer.
3. The engineer implements in a separate branch, with tests.
4. A reviewer reads the diff against `main` and either approves or returns
   it with concrete findings.
5. The release engineer merges (`git merge --no-ff`) and pushes `main` to
   origin (and to the local mirror).

## Branch rule

Branch name = short topic + hyphenated description
(`seam-td-push-registration`). One branch — one change; don't mix
unrelated edits.

## Definition of done

- `dart test` is green for the touched modules;
- for schema-touching changes: `tools/td_schema_check.py` passes (field names
  cross-checked against the official TDLib `td_api.tl`);
- the change description says what problem it solves and how it was verified
  (command + output);
- no secrets, no internal hostnames/paths, no internal ticket numbers in the
  diff or commit messages;
- the merge reached origin (GitHub) — a live `git ls-remote` confirms it.

## What stays internal (the "don't leak" list)

This repository may be read outside the team that builds it. Never put into
files, commit messages, branch names, or PR descriptions:

- internal ticket/tracker numbers or links to internal chats and directives;
- internal hostnames, IP addresses, or file paths of internal machines;
- names of internal teams, agents, or role handles.

Reference work via GitHub-native Issues/PRs (`#123`). New commit messages
reference GitHub issues, not internal task IDs.

## Git remotes

- Origin is GitHub (`https://github.com/BastionPrime/wellmagram.git`),
  authentication via managed credentials (profile token + `~/.git-credentials`);
  never print or commit the token.
- The local bare repository is remote `mirror` — fallback and clone seed.
- Every merge to `main` and every release tag is pushed to origin immediately,
  in the same session where it was made. "Done" without a push to origin is
  not done.
- Force-push is forbidden; history is never rewritten. If internal data leaks
  into a pushed tree, fix the HEAD with a new commit and report to the owner.
