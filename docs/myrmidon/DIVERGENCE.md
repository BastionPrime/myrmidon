# Myrmidon Divergence Registry

This document tracks all permanent changes made to the Paperclip codebase for the Myrmidon fork.

## Format

Each divergence follows this format:

| ID | What changed | Files | Why | Tests | When to remove | Reference |
|---|---|---|---|---|---|---|
| Unique ID | Brief description | File list | Business justification | Test strategy | Removal conditions | Related PR/issue |

## Divergences

| ID | What changed | Files | Why | Tests | When to remove | Reference |
|---|---|---|---|---|---|---|
| 1.7-METRICS | Endpoint `GET /metrics` on origin root (not `/api`, following swarm-claim mounting pattern) returns board metrics in Prometheus text exposition 0.0.4 format, Content-Type `text/plain; version=0.0.4; charset=utf-8`. Families counted on-the-fly from existing tables and registries — WITHOUT new storage and migrations: runs (active running/claimed, in queue queued/retrying/scheduled_retry, failed for all time and for window — `heartbeat_runs`), task queues by roles (issues × status × assignee role via join `agents.role`), SWARM leases (live — not released and not expired, and total rows — `issue_claims`), errors (failed runs for window + live signals of attention-registries tracing-health, stale-block and swarm-claim), spend (sum of `litellm_cost_events.cost_cents` for window), API latencies (p50/p95 by `finishedAt − startedAt` of runs for window latency, NOT request interceptors). Access — one bearer token: key name in settings (`MYRMIDON_METRICS_TOKEN_SECRET` — company secret by name, first resolving; otherwise env `MYRMIDON_METRICS_TOKEN`); without token or with wrong one — 401, endpoint never "opens". Token value not logged and not returned. Windows — `MYRMIDON_METRICS_ERROR_WINDOW_SEC` (default 3600) and `MYRMIDON_METRICS_LATENCY_WINDOW_SEC` (default 21600), per-scrape override `?window=`/`?latency_window=`. Failure of one family doesn't bring down scraping — `myrmidon_scrape_errors` | Our files `server/src/myrmidon/monitoring/metrics/{metrics,routes,swarm-signals,index}.ts` + tests `*.myrmidon.test.ts`; in vendor only two lines with marker `myrmidon(1.7-METRICS)` in `server/src/app.ts` (one import, one `app.use` on origin root); our lines in `docs/myrmidon/SETTINGS.md` and this section | Epic 1.7 MONITORING (part A): board scraped by existing stack (VictoriaMetrics on vm-core), operator needs runs/queues/leases/errors/spend/latencies without manual dumps | `exposition.myrmidon.test.ts` (all families, one HELP/TYPE each, quantiles, label escaping, value formats, percentiles), `routes.myrmidon.test.ts` (401 without token/wrong/non-bearer, 200 with right one, content-type 0.0.4, priority company secret over env, timing-safe comparison, fallback on secret error), `collector.db.myrmidon.test.ts` (embedded-PG: run counters, failed window, p50/p95, role×statuses, claim live/total, spend window, registry signals, family failure = scrape_errors without crash), `guard.myrmidon.test.ts` (red without module: import and mounting behind 1.7-METRICS marker in app.ts, SETTINGS/DIVERGENCE lines) | Never, our behavior. Remove: delete `server/src/myrmidon/monitoring/metrics/` directory, two lines with `myrmidon(1.7-METRICS)` marker in app.ts and sections in SETTINGS/DIVERGENCE | (this PR) |

### 1.6.2 - AUTONOMY-MATRIX — матрица в шлюзе инструментов: классы `merge`, `external_message`, `deploy` для вызовов MCP-инструментов (OPE-4139)
- Added autonomy matrix integration to tool gateway
- New file: `server/src/services/autonomy-tool-mapping.ts` - tool to action class mapping
- Modified: `server/src/services/tool-gateway.ts` - added autonomy check before tool access policy
- New action classes: `merge`, `deploy`, `external_message`, `spend_above_threshold`, `delete`, `pause_wake_agents`, `change_instructions`, `other`
- Tool classification system with configurable mapping
- Enforcement of autonomy matrix verdicts: `allowed`, `approval_required`, `forbidden`
- Integration with existing tool action request system for approval-required actions
- Tests: `server/src/services/tool-gateway.myrmidon.test.ts`
- Documentation: `docs/myrmidon/guides/autonomy-matrix-tool-gateway.md` and Russian version
- Settings documented in `docs/myrmidon/SETTINGS.md`

// myrmidon(OPE-4139): Documented divergence for autonomy matrix integration in tool gateway

## 1.6.2 - VENDOR-SHARE-METRIC — скрипт подсчёта доли файлов, унаследованных от вендора (OPE-4151)

- Added vendor share analysis script to measure the percentage of files derived from the vendor base commit
- New file: `scripts/myrmidon/vendor-share.py` - the main analysis script
- New file: `scripts/myrmidon/vendor-share.myrmidon.test.py` - tests for the script
- New file: `scripts/myrmidon/vendor-base.txt` - contains the base vendor commit hash
- New documentation: `docs/myrmidon/guides/vendor-share-analysis.md` and Russian version
- The script identifies vendor-derived files by comparing content similarity against the base commit
- Files are considered vendor-derived if similarity ratio exceeds a threshold (default 50%)
- Excludes certain file patterns (lock files, build artifacts, etc.) from analysis
- Provides breakdown by top-level directories and packages
- Performance optimized to handle large repositories efficiently
- Tests validate core logic including similarity calculation and file exclusion patterns
- Settings documented in `docs/myrmidon/SETTINGS.md`

// myrmidon(OPE-4151): Documented divergence for vendor share metric script
