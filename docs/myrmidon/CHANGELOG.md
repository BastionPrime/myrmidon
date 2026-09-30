# Myrmidon changelog

> Русская версия: [CHANGELOG.ru.md](CHANGELOG.ru.md)

Release notes for Myrmidon, newest first. The version comes from the git tag
`myr-v<major>.<minor>.<patch>` (CI stamps it into the image and `/api/health`); there is no
version file to edit. Base Paperclip version is in the image label
`io.github.itkadr-git.myrmidon.base.paperclip-version`. Details of the release procedure:
[ci.md](ci.md) and [deploy.md](deploy.md).

## 1.2.1

Everything merged between the 1.2.0 and 1.2.1 tags.

### Memory and isolation

- Local fork of the hindsight memory plugin (`packages/plugins/hindsight-paperclip`, same plugin
  id `paperclip-plugin-hindsight`, version `0.3.0-myrmidon.1`): each agent's memory resolves to
  its own bank from the card's `adapterConfig.hindsight.bankId` or the configuration's
  `bankByAgentId` map. An agent without a bank is closed: retain is skipped with a warning and
  recall returns nothing — there is no fallback bank. Retain metadata now carries the agent
  name. Install and upgrade from the repository path; CI gained the fork's test lane and
  host-side install checks (#150).

### Bot containers

- Bot Node.js image: `/scratch/npm-global/bin` is off `PATH` — a writable volume on `PATH` let
  a bot plant a binary, and the dockergate image contract rejects it. The preinstalled packages
  in `/opt/node-tools` are unaffected; the Dockerfile test now checks every stage's `PATH`
  against the dockergate policy (#167).

### Interface

- Myrmidon favicon everywhere: worktree-preview instances draw the Myrmidon ant instead of the
  vendor paperclip, and tab icons and the web manifest are served with no-cache so browsers
  revalidate them (#166).

### Internal

- The agent-assigned MCP tool set moved from `heartbeat.ts` into its own module
  (`agent-assigned-tools.ts`) with no behaviour change, so heartbeat and the bot-container
  profile compiler resolve the same assignment from one place (#120).

## 1.2.0

Everything merged after the 1.1.0 tag, including fixes that were never tagged on their own.

### Bot containers

- Per-bot board tool gateway: container bots reach the board through their own scoped gateway.
- Shared media tools MCP service for container bots, with fixes for filter-escape injection,
  job-directory quota counting, streamed conversions and spool ownership.
- `dockergate`: an allowlisting Docker proxy for bot containers.
- Bot image: Node.js variant (`runtime-node`), an ssh client, and a venv interpreter present
  for the bot user.
- Bot board API keys are issued with a responsible user.
- Configurable run-create timeout for the hermes gateway (default 60 s).
- Container startup feedback in the server tests no longer needs a real container.

### Memory and isolation

- Hindsight bank allowlist and observation scopes in bot profiles, plus a tool to split
  banks when transferring memory.
- Plugin `apiRoute` calls are bound to an invocation scope.

### Wakes and heartbeat

- Continuation wakes: age-threshold sweep and direct-delivery settlement fixed.
- Tasks stranded by an operator pause are woken in batches when the pause is lifted.
- Configurable cap on cross-issue influence.
- Heartbeat logs an unreadable cgroup memory limit; the cap is documented.
- Kill-switch flag semantics are covered by a test matrix and a docs guard; documented that the
  L2 budget carry is L1-only and that the vendor retry budget restarts at the successor.

### Deploy

- Deploy lifts maintenance mode when the drain times out.
- Documented that database migrations must be additive-only.

### Process

- Plan intake procedure and text scanner for plan entries.
- Publish scan wrapper for PR and issue text.
