-- scripts/myrmidon/baseline-spot-check.sql
--
-- myrmidon(1.6-BASELINE): the manual spot check for the BASELINE metrics.
--
-- Run it on a test database and compare the numbers with
-- GET /api/myrmidon/companies/:companyId/baseline/metrics?from&to for the same
-- window. The task ids below are placeholders: replace them with three real ids
-- of the instance you are checking. The script reproduces the definitions the
-- server uses (see server/src/myrmidon/baseline/metrics.ts):
--   * a task counts when its completed_at falls inside [window_from, window_to];
--   * cycle time runs from the earliest transition into todo/in_progress
--     (falling back to created_at) to completed_at;
--   * review/blocked time sums that task's status segments, clipped to the
--     window, an open segment ending at window_to;
--   * a return is a transition in_review -> in_progress;
--   * each blocked segment's time is attributed to every current blocker of the
--     task (issue_relations type = 'blocks');
--   * runs come from heartbeat_runs.context_snapshot->>'issueId';
--   * cost comes from litellm_cost_events when the window has rows there,
--     otherwise from cost_events.
--
-- Usage:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/myrmidon/baseline-spot-check.sql

\set company_id  '00000000-0000-4000-8000-000000000001'
\set window_from '2026-09-01T00:00:00Z'
\set window_to   '2026-09-30T00:00:00Z'
\set task_1      '00000000-0000-4000-8000-000000000101'
\set task_2      '00000000-0000-4000-8000-000000000102'
\set task_3      '00000000-0000-4000-8000-000000000103'

with w as (
  select :'window_from'::timestamptz as from_ts, :'window_to'::timestamptz as to_ts
),
tasks as (
  select i.id, i.project_id, i.assignee_agent_id, i.created_at, i.completed_at
  from issues i, w
  where i.company_id = :'company_id'
    and i.completed_at between w.from_ts and w.to_ts
    and i.id::text in (:'task_1', :'task_2', :'task_3')
),
transitions as (
  select a.entity_id::uuid as issue_id,
         a.created_at as at,
         a.details -> '_previous' ->> 'status' as from_status,
         a.details ->> 'status' as to_status
  from activity_log a
  join tasks t on t.id::text = a.entity_id
  where a.company_id = :'company_id'
    and a.entity_type = 'issue'
    and a.action = 'issue.updated'
    and a.details ->> 'status' is not null
),
segments as (
  select issue_id,
         to_status as status,
         at as seg_start,
         lead(at) over (partition by issue_id order by at) as seg_end
  from transitions
),
segment_hours as (
  select s.issue_id,
         s.status,
         greatest(
           0,
           extract(epoch from (
             least(coalesce(s.seg_end, w.to_ts), w.to_ts) - greatest(s.seg_start, w.from_ts)
           )) / 3600.0
         ) as hours
  from segments s, w
),
cycle_start as (
  select tr.issue_id, min(tr.at) as start_at
  from transitions tr
  where tr.to_status in ('todo', 'in_progress')
  group by tr.issue_id
),
cost_source as (
  select case
    when exists (
      select 1 from litellm_cost_events lc, w
      where lc.company_id = :'company_id'
        and lc.occurred_at between w.from_ts and w.to_ts
    ) then 'litellm_cost_events'
    when exists (
      select 1 from cost_events ce, w
      where ce.company_id = :'company_id'
        and ce.occurred_at between w.from_ts and w.to_ts
    ) then 'cost_events'
    else 'none'
  end as source
),
costs as (
  select lc.issue_id::uuid as issue_id, lc.cost_cents as cents, lc.occurred_at as at
  from litellm_cost_events lc, w
  where (select source from cost_source) = 'litellm_cost_events'
    and lc.company_id = :'company_id'
    and lc.occurred_at between w.from_ts and w.to_ts
  union all
  select ce.issue_id, ce.cost_cents, ce.occurred_at
  from cost_events ce, w
  where (select source from cost_source) = 'cost_events'
    and ce.company_id = :'company_id'
    and ce.occurred_at between w.from_ts and w.to_ts
),
runs as (
  select (r.context_snapshot ->> 'issueId')::uuid as issue_id, r.started_at as at
  from heartbeat_runs r, w
  where r.company_id = :'company_id'
    and r.started_at between w.from_ts and w.to_ts
    and (r.context_snapshot ->> 'issueId') is not null
),
blockers as (
  select ir.related_issue_id as issue_id, ir.issue_id as blocker_id
  from issue_relations ir
  where ir.company_id = :'company_id' and ir.type = 'blocks'
),
per_task as (
  select t.id as issue_id,
         t.project_id,
         t.assignee_agent_id,
         coalesce(a.role, 'unassigned') as role,
         round(extract(epoch from (t.completed_at - coalesce(cs.start_at, t.created_at))) / 3600.0, 2) as cycle_hours,
         round(coalesce((
           select sum(sh.hours) from segment_hours sh
           where sh.issue_id = t.id and sh.status = 'in_review'
         ), 0), 2) as review_hours,
         round(coalesce((
           select sum(sh.hours) from segment_hours sh
           where sh.issue_id = t.id and sh.status = 'blocked'
         ), 0), 2) as blocked_hours,
         (select count(*) from runs r where r.issue_id = t.id) as runs,
         coalesce((select sum(c.cents) from costs c where c.issue_id = t.id), 0) as cost_cents,
         exists (
           select 1 from transitions tr
           where tr.issue_id = t.id and tr.to_status = 'in_review' and tr.from_status is distinct from 'in_review'
         ) as entered_review,
         exists (
           select 1 from transitions tr
           where tr.issue_id = t.id and tr.from_status = 'in_review' and tr.to_status = 'in_progress'
         ) as returned
  from tasks t
  left join cycle_start cs on cs.issue_id = t.id
  left join agents a on a.id = t.assignee_agent_id and a.company_id = :'company_id'
)
select * from per_task order by issue_id;

-- SPOT-CHECK-SPLIT: the by-project aggregate below is the block the PR compares
-- with GET .../baseline/metrics (field by field, discrepancy 0).
-- by project (key is the project id, or 'no-project')
with w as (
  select :'window_from'::timestamptz as from_ts, :'window_to'::timestamptz as to_ts
),
tasks as (
  select i.id, i.project_id, i.assignee_agent_id, i.created_at, i.completed_at
  from issues i, w
  where i.company_id = :'company_id'
    and i.completed_at between w.from_ts and w.to_ts
    and i.id::text in (:'task_1', :'task_2', :'task_3')
),
transitions as (
  select a.entity_id::uuid as issue_id, a.created_at as at,
         a.details -> '_previous' ->> 'status' as from_status,
         a.details ->> 'status' as to_status
  from activity_log a
  join tasks t on t.id::text = a.entity_id
  where a.company_id = :'company_id' and a.entity_type = 'issue'
    and a.action = 'issue.updated' and a.details ->> 'status' is not null
),
segments as (
  select issue_id, to_status as status, at as seg_start,
         lead(at) over (partition by issue_id order by at) as seg_end
  from transitions
),
segment_hours as (
  select s.issue_id, s.status,
         greatest(0, extract(epoch from (
           least(coalesce(s.seg_end, w.to_ts), w.to_ts) - greatest(s.seg_start, w.from_ts)
         )) / 3600.0) as hours
  from segments s, w
),
cycle_start as (
  select tr.issue_id, min(tr.at) as start_at
  from transitions tr where tr.to_status in ('todo', 'in_progress')
  group by tr.issue_id
),
cost_source as (
  select case
    when exists (select 1 from litellm_cost_events lc, w where lc.company_id = :'company_id' and lc.occurred_at between w.from_ts and w.to_ts) then 'litellm_cost_events'
    when exists (select 1 from cost_events ce, w where ce.company_id = :'company_id' and ce.occurred_at between w.from_ts and w.to_ts) then 'cost_events'
    else 'none' end as source
),
costs as (
  select lc.issue_id::uuid as issue_id, lc.cost_cents as cents
  from litellm_cost_events lc, w
  where (select source from cost_source) = 'litellm_cost_events' and lc.company_id = :'company_id' and lc.occurred_at between w.from_ts and w.to_ts
  union all
  select ce.issue_id, ce.cost_cents from cost_events ce, w
  where (select source from cost_source) = 'cost_events' and ce.company_id = :'company_id' and ce.occurred_at between w.from_ts and w.to_ts
),
runs as (
  select (r.context_snapshot ->> 'issueId')::uuid as issue_id
  from heartbeat_runs r, w
  where r.company_id = :'company_id' and r.started_at between w.from_ts and w.to_ts
    and (r.context_snapshot ->> 'issueId') is not null
),
per_task as (
  select t.id, coalesce(t.project_id::text, 'no-project') as key,
         extract(epoch from (t.completed_at - coalesce(cs.start_at, t.created_at))) / 3600.0 as cycle_hours,
         coalesce((select sum(sh.hours) from segment_hours sh where sh.issue_id = t.id and sh.status = 'in_review'), 0) as review_hours,
         coalesce((select sum(sh.hours) from segment_hours sh where sh.issue_id = t.id and sh.status = 'blocked'), 0) as blocked_hours,
         (select count(*) from runs r where r.issue_id = t.id) as runs,
         coalesce((select sum(c.cents) from costs c where c.issue_id = t.id), 0) as cost_cents,
         exists (select 1 from transitions tr where tr.issue_id = t.id and tr.to_status = 'in_review' and tr.from_status is distinct from 'in_review') as entered_review,
         exists (select 1 from transitions tr where tr.issue_id = t.id and tr.from_status = 'in_review' and tr.to_status = 'in_progress') as returned
  from tasks t
  left join cycle_start cs on cs.issue_id = t.id
)
select key,
       count(*) as tasks_completed,
       round(avg(cycle_hours)::numeric, 2) as cycle_mean,
       round(percentile_cont(0.5) within group (order by cycle_hours)::numeric, 2) as cycle_median,
       round(percentile_cont(0.9) within group (order by cycle_hours)::numeric, 2) as cycle_p90,
       round(avg(review_hours)::numeric, 2) as review_mean,
       round(percentile_cont(0.5) within group (order by review_hours)::numeric, 2) as review_median,
       count(*) filter (where entered_review) as entered_review,
       count(*) filter (where returned) as returned,
       round(sum(blocked_hours)::numeric, 2) as blocked_total,
       round(avg(blocked_hours)::numeric, 2) as blocked_mean,
       sum(runs) as runs_total,
       round(avg(runs)::numeric, 2) as runs_mean,
       sum(cost_cents) as cost_total_cents,
       round(avg(cost_cents)::numeric, 2) as cost_mean_cents
from per_task
group by key
order by key;