-- WhatsApp Campaign Sender — database schema
-- Run this once in Supabase: Dashboard → SQL Editor → New query → paste → Run.
-- Safe to re-run: everything is IF NOT EXISTS.

-- ---------------------------------------------------------------- contacts
create table if not exists contacts (
  id           text primary key,
  phone        text not null unique,          -- E.164 digits, no '+'
  raw          text,                          -- exactly what was in your file
  name         text default '',
  fields       jsonb not null default '{}',   -- every other column from your import
  tags         text[] not null default '{}',  -- your categories
  opt_out      boolean not null default false,
  opt_out_at   timestamptz,
  invalid      boolean not null default false,
  created_at   timestamptz not null default now(),
  last_sent_at timestamptz
);

create index if not exists contacts_tags_idx    on contacts using gin (tags);
create index if not exists contacts_active_idx  on contacts (opt_out, invalid);
create index if not exists contacts_lastsent_idx on contacts (last_sent_at);

-- --------------------------------------------------------------- campaigns
create table if not exists campaigns (
  id            text primary key,
  name          text not null,
  status        text not null default 'draft',  -- draft|running|paused|done|stopped
  mode          text not null default 'template',
  template      jsonb,
  text_variants jsonb not null default '[]',
  audience      jsonb not null default '{}',
  throttle      jsonb not null default '{}',
  dry_run       boolean not null default false,
  stats         jsonb not null default '{}',
  last_error    text,
  created_at    timestamptz not null default now(),
  started_at    timestamptz,
  finished_at   timestamptz
);

create index if not exists campaigns_status_idx on campaigns (status);

-- -------------------------------------------------------------- recipients
-- One row per person per campaign. This is the send queue and the audit log.
create table if not exists recipients (
  id          bigserial primary key,
  campaign_id text not null references campaigns (id) on delete cascade,
  contact_id  text,
  phone       text not null,
  name        text default '',
  status      text not null default 'pending', -- pending|sent|failed|skipped
  attempts    integer not null default 0,
  message_id  text,                            -- Meta wamid
  delivery    text,                            -- sent|delivered|read|failed
  error       text,
  code        integer,
  hint        text,
  preview     text,                            -- what a dry run would have sent
  sent_at     timestamptz,
  position    integer not null default 0       -- preserves the shuffled order
);

create index if not exists recipients_campaign_idx  on recipients (campaign_id, status);
create index if not exists recipients_order_idx     on recipients (campaign_id, position);
create index if not exists recipients_message_idx   on recipients (message_id);

-- --------------------------------------------------------------- send log
-- Feeds the hourly / daily caps, which apply across ALL campaigns.
create table if not exists send_log (
  id          bigserial primary key,
  sent_at     timestamptz not null default now(),
  phone       text,
  campaign_id text,
  ok          boolean not null default true
);

create index if not exists send_log_time_idx on send_log (sent_at);

-- ------------------------------------------------------------------ inbox
create table if not exists inbox (
  id         bigserial primary key,
  from_phone text not null,
  body       text,
  opt_out    boolean not null default false,
  at         timestamptz not null default now()
);

create index if not exists inbox_time_idx on inbox (at desc);

-- --------------------------------------------------------------- settings
-- Single row holding app configuration (phone number id, pacing defaults, …).
create table if not exists app_settings (
  id       integer primary key default 1,
  data     jsonb not null default '{}',
  constraint app_settings_single_row check (id = 1)
);

insert into app_settings (id, data) values (1, '{}') on conflict (id) do nothing;

-- --------------------------------------------------------------- sessions
create table if not exists sessions (
  token      text primary key,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index if not exists sessions_expiry_idx on sessions (expires_at);

-- ------------------------------------------------------------------- RLS
-- This app talks to Postgres only from its own server, using the service_role
-- key, which bypasses RLS. Enabling RLS with no policies means that if the
-- anon/publishable key ever leaks, it still reads nothing.
alter table contacts     enable row level security;
alter table campaigns    enable row level security;
alter table recipients   enable row level security;
alter table send_log     enable row level security;
alter table inbox        enable row level security;
alter table app_settings enable row level security;
alter table sessions     enable row level security;
