-- Stops two servers (e.g. your laptop and Hostinger) from running the SAME
-- campaign at once and sending every message twice.
-- Run in Supabase → SQL Editor. Safe to re-run.

alter table campaigns add column if not exists runner_id text;
alter table campaigns add column if not exists heartbeat timestamptz;

create index if not exists campaigns_heartbeat_idx on campaigns (heartbeat);

-- Any campaign left "running" by a crash has a stale heartbeat and can be
-- claimed again; one with a fresh heartbeat belongs to a live server.
comment on column campaigns.runner_id is 'Which server instance is sending this campaign right now.';
comment on column campaigns.heartbeat is 'Updated after every message. Older than a few minutes means the runner died.';
