# WhatsApp Campaign Sender

A local web app for sending promotional WhatsApp campaigns to your client list through the
official **Meta WhatsApp Cloud API** — with import, personalisation, randomised pacing,
caps, quiet hours, automatic opt-out handling and per-recipient delivery tracking.

Your data lives in your own Supabase (Postgres) project; the app is a Node server you run
locally or host yourself. Nobody else sees your client list.

---

## Read this first: how WhatsApp promotion actually works

This is the part that decides whether your number survives.

1. **You cannot send free-form promo text to a cold list.** If a person has not messaged you
   in the last 24 hours, the only thing that will reach them is a **template that Meta has
   already approved**, in the **MARKETING** category. You create templates in
   *Meta Business Manager → WhatsApp Manager → Message templates*; approval usually takes
   minutes to a few hours. This app loads your approved templates and fills in their variables
   per contact.
2. **Free text** (the second mode in the app) only reaches contacts with an open 24-hour
   window — i.e. people who replied to you recently. Useful for follow-ups, useless for a blast.
3. **What gets you banned is not speed, it is complaints.** Your number carries a quality
   rating (green / yellow / red) driven by people pressing *Block* and *Report*. Two red
   periods and your sending limit is cut; keep going and the number is disabled. Delays help
   you look human and keep you under rate limits, but the real protection is: send only to
   people who gave you their number and expect to hear from you, make the offer genuinely
   relevant, and honour opt-outs instantly.
4. **Tiers.** New numbers start at 250 unique contacts / 24h, then 1K → 10K → 100K as your
   quality holds. The daily cap in the app should match your tier — sending past it just
   produces errors.

The **Careful** preset (45–120s random gaps, batches of 25 with a 20 minute break, 200/day,
40/hour, 09:00–20:00 only) matches what a brand-new number is allowed. Stay on it until your
quality has been green for a few weeks.

---

## Setup

```bash
npm install
npm start
```

Open <http://localhost:3000> and follow the four steps on the **Start here** tab — it walks you
through the Meta side, tests your credentials, and tells you what's still missing.

**[SETUP.md](SETUP.md) is the full click-by-click walkthrough** of both sides (which of Meta's
three websites you need for what, how to make a token that doesn't expire, how to get your
promo template approved, how to connect replies). Read that one if anything is unclear.

You can pre-fill credentials by copying `.env.example` to `.env` instead of typing them in the UI.

The app is password-protected: on first run it asks you to choose one (or set `APP_PASSWORD`).
To host it online, follow **[DEPLOY.md](DEPLOY.md)** — it covers which Hostinger plans can run
Node.js, moving your token into an environment variable, nginx + HTTPS, and backups.

---

## Using it

**Start here** — the four setup steps, each with a live status: credentials tested against
Meta, your approved templates listed, webhook connectivity. Green means done.

**Contacts** — drop in a CSV or `.xlsx`. Phone and name columns are auto-detected; you
confirm on a preview screen that shows exactly what will be imported, which numbers are
unusable, and which are duplicates. Numbers are normalised to E.164 (`0612345678` →
`212612345678`). Every other column is kept and becomes a placeholder you can use in messages.
Tag each batch (`clients-2026`, `vip`, …) so you can target it later.

**Send** — three steps: what, who, how fast. Pick an approved template and map its `{{1}}`,
`{{2}}` … to your data:

| You write | Result |
|---|---|
| `{{name}}` | contact's name |
| `{{city}}` | any column from your file |
| `{{name\|client}}` | name, or `client` when the field is empty |
| `{Bonjour\|Salut}` | one of the two, picked at random per message |

Then choose the audience (by tag, skipping anyone contacted in the last N days, optional cap),
and pick a speed — **Careful / Normal / Fast**. A line in plain words tells you what that means
and how long your list will take; *Fine-tune the numbers* opens the individual knobs if you
want them.

**Test run** is on by default. It walks the whole campaign and records the exact message each
person would have received, without sending anything. Read a few, then untick it and send for real.

**Results** — start, pause, resume, stop. Live counters for sent / delivered / read /
failed / skipped, per-recipient errors with a plain-English explanation of each Meta error
code, retry-failed, CSV export. Closing the app or rebooting is safe — progress is in the
database and an interrupted campaign resumes itself on the next start. Replies appear at the bottom of the same tab;
anything matching an opt-out keyword (`stop`, `unsubscribe`, `arrêt`, `توقف`, … — editable in
step 4) unsubscribes that contact permanently.

---

## The safety machinery

| Mechanism | What it does |
|---|---|
| Randomised delay | every gap is a fresh random value between your min and max — no fixed rhythm |
| Batches | after N messages, a longer pause (±25% jitter) before the next batch |
| Daily / hourly caps | counted across *all* campaigns over a rolling window, not per campaign |
| Send window | nothing goes out outside your chosen hours; the run sleeps and resumes by itself |
| Auto-pause | if >30% of the last 20 sends fail, the campaign stops and tells you why |
| Rate-limit backoff | error 130429 / 131048 / 131056 → exponential backoff, recipient requeued, nothing lost |
| Token / account errors | pause the whole campaign immediately instead of burning the list |
| Skip lists | opted-out, invalid, and recently-contacted numbers never enter a campaign |
| Spintax + variants | messages are not byte-identical across recipients |
| Auto-resume | a campaign interrupted by a restart, deploy or crash picks itself back up on startup |
| Password login | scrypt-hashed password, HttpOnly session cookie, login rate limiting |
| Webhook signature check | with `WA_APP_SECRET` set, forged delivery statuses and opt-outs are rejected |
| Per-user marketing limit | error 131049 is recorded as *skipped*, not failed — that person simply gets it next time |

Errors that mean "this number is not on WhatsApp" (131026) are never retried; transient
network errors are retried up to 3 times.

---

## Files

```
src/server.js     HTTP API + webhook receiver
src/sender.js     the campaign loop: pacing, caps, retries, auto-pause
src/whatsapp.js   Cloud API client + error classification
src/import.js     CSV / XLSX parsing and column detection
src/phone.js      phone normalisation to E.164
src/data.js       Supabase data layer (contacts, campaigns, recipients, sessions)
src/auth.js       password login, sessions, webhook signature check
public/           the interface
supabase/         schema.sql — run this once in the Supabase SQL editor
scripts/          check-key, migrate-to-supabase, reset-password
```

Your WhatsApp access token is stored in the `app_settings` table unless you set
`WA_ACCESS_TOKEN` as an environment variable, which is preferred when hosting. The
`data/` folder is only the old file-based storage, kept as a fallback copy.

## Only ever run one copy

`npm start` and `npm run dev` are two separate instances. Postgres keeps their data
consistent now, but both would run the same campaigns and **send every message twice**. The app
refuses to start if another copy is alive and tells you which process to stop. If a run crashed
and left a stale lock behind, delete `.instance.lock`.

## Forgot your login password?

There is no recovery — the password is stored as a one-way scrypt hash, so it cannot be read
back. Clear it and choose a new one:

```bash
node scripts/reset-password.mjs
```

Then **restart the app** (settings are cached in memory while it runs) and open it: you get the
"Choose a password" screen again. Contacts, campaigns and logs are untouched.

On a server, run the same command in the app's directory and restart it — or, if you configured
`APP_PASSWORD` as an environment variable, just change it there and restart. The env variable
always wins over a password chosen in the browser.

## Checking your setup

```bash
node scripts/check-key.mjs
```

Confirms your Supabase key is the service_role one, that the database is reachable, and that
all the tables exist — without printing the key. Run it first whenever something looks wrong.

## Legal note

Sending marketing to people who did not opt in is against Meta's Business Messaging policy
and, in most countries, against consumer/data-protection law (GDPR in the EU, law 09-08 in
Morocco). This tool assumes the numbers in your database are your own clients who agreed to
be contacted. Keep a record of that consent.
