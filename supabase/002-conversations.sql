-- Adds two-way conversations to an existing install.
-- Run in Supabase → SQL Editor. Safe to re-run.

-- The inbox becomes a full message log: inbound and outbound.
alter table inbox add column if not exists direction   text not null default 'in';  -- in | out
alter table inbox add column if not exists message_id  text;                        -- Meta wamid
alter table inbox add column if not exists status       text;                       -- sent|delivered|read|failed
alter table inbox add column if not exists msg_type     text default 'text';

create index if not exists inbox_thread_idx  on inbox (from_phone, at desc);
create index if not exists inbox_wamid_idx   on inbox (message_id);

-- Per-contact conversation state, so the app knows whether the free-text
-- 24-hour service window is still open for that person.
alter table contacts add column if not exists last_inbound_at  timestamptz;
alter table contacts add column if not exists unread_count     integer not null default 0;

create index if not exists contacts_inbound_idx on contacts (last_inbound_at desc);

-- Backfill last_inbound_at from whatever is already in the inbox.
update contacts c
   set last_inbound_at = sub.latest
  from (select from_phone, max(at) as latest from inbox where direction = 'in' group by from_phone) sub
 where c.phone = sub.from_phone
   and c.last_inbound_at is null;
