---
name: parallel-helpers
description: When an engineering task should be split across parallel helper subagents (delegate_task) and when it must stay in one context — independent reads, tests vs implementation, self-review, and the anti-collision rules.
key: paperclipai/bundled/software-development/parallel-helpers
recommendedForRoles:
  - engineer
tags:
  - delegation
  - parallelism
  - testing
  - code-review
---

# Parallel Helpers

Split work across helper subagents (`delegate_task`) when the parts are independent, and keep it in one context when they are not. Helpers are not free: each one re-reads context from scratch, and two helpers on the same file will collide.

## When to delegate

- **Reading/mapping before coding.** "Find every place X is used", "summarize how module Y works", "list the tests that cover Z" — one helper per area, all at once. These are read-only, so they cannot collide.
- **Independent parts of the change.** Server part vs UI part vs docs, or different modules — one helper per part, each on files no other helper touches.
- **Tests alongside the implementation.** One helper writes the tests from the acceptance criteria while you implement. Agree on the contract (types, function names) before spawning, so the two sides meet.
- **Self-review before the PR.** One helper reviews your diff against the task's acceptance criteria and the repo conventions; another checks for missing tests/docs. Read their findings with your own eyes before acting on them.
- **Investigating a CI failure.** One helper per failing job, each with the log excerpt and the failing test name.

## When NOT to delegate

- A small single-file change. Do it yourself; the spawn overhead costs more than it saves.
- Two helpers on the **same file** — never. Split by file, or do it sequentially.
- Anything whose next step depends on the result of the previous step. Sequential work in one context beats a chain of spawns.
- Git operations (commit, push, rebase, open PR). Only the task owner does those; helpers never do.

## Rules that keep helpers useful

- Give each helper a **self-contained goal**: what to produce, which files it may change (or "read only"), what to return. A helper does not see your conversation.
- Bound each helper to a **per-helper turn budget** when the card offers one, so a lost helper cannot burn a whole run.
- Check the helper's result — diff, test output — before building on it. A helper's claim is a hypothesis until you see the evidence.
- Helpers multiply cost. If a part turns out to need deep back-and-forth, pull it back into your own context and finish it there.

## Where the limits come from

The per-agent limit and the helper model are set on your agent card ("Parallel helpers"); the allowed range is a company-level setting your operator edits, with no built-in upper limit — the number the operator saves is the limit. If `delegate_task` is not available, the card has helpers switched off — ask in the task thread, do not work around it.
