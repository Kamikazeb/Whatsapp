# Context prompt for ChatGPT (or any other assistant)

Copy everything below the line.

---

I'm building a WhatsApp promotional campaign sender for my own client database. I need help
with [REPLACE THIS WITH YOUR QUESTION]. Here's the full context so you don't have to guess.

## The goal

I own a business with a database of clients (name, phone, city, last visit — in an Excel file).
I want to send them promotional WhatsApp messages — a discount campaign, for example — without
getting my WhatsApp number banned or restricted.

## What I'm using

The **official Meta WhatsApp Cloud API** (Graph API), not an unofficial library like
whatsapp-web.js or Baileys. I already created an app on developers.facebook.com and registered
my phone number on it.

## Key constraints I already understand (don't re-explain these unless I'm wrong)

- To message someone who has NOT written to me in the last 24 hours, I can only send a
  **template that Meta approved in advance**, in the **MARKETING** category. Free-form text
  only works inside an open 24-hour customer service window.
- Templates support variables `{{1}}`, `{{2}}` … which I fill per recipient (client's name, city…).
- My number has a **quality rating** (green/yellow/red) driven by people pressing Block/Report,
  and a **messaging tier** (250 → 1K → 10K → 100K unique recipients per 24h). Bans come from
  complaints, not from sending speed — but rate limits and pacing still matter.
- Relevant Meta error codes: 131026 (not on WhatsApp), 131047 (window closed, need template),
  131049 (per-user marketing limit — skip, retry later), 131048 (spam rate limit), 130429
  (throughput), 132015 (template paused for quality), 190 (token expired), 131031 (account restricted).

## What I've built so far

A local web app — **Node.js 22 + Express + vanilla JS frontend + JSON file storage** (no
database, no native dependencies). It runs on localhost:3000 and my client data never leaves
my machine.

```
src/server.js     HTTP API + Meta webhook receiver
src/sender.js     campaign loop: pacing, caps, retries, auto-pause
src/whatsapp.js   Cloud API client + error classification
src/import.js     CSV / XLSX parsing, auto column detection
src/phone.js      phone normalisation to E.164
src/store.js      JSON storage with atomic writes
public/           4-tab UI: Start here / Contacts / Send / Results
data/             contacts, campaigns, logs (git-ignored)
```

**Features that already work:**

- **Import**: CSV or Excel upload, auto-detects the phone and name columns (handles French/Arabic
  header names), normalises numbers to E.164 (`0612345678` → `212612345678` with a configurable
  default country code), preview-before-commit screen, dedupe against existing contacts, batch tagging.
  Extra columns are kept and usable as message variables.
- **Personalisation**: `{{name}}`, `{{city}}` (any column), fallbacks `{{name|client}}`, and
  spintax `{Bonjour|Salut}` so messages aren't byte-identical.
- **Pacing presets** (Careful / Normal / Fast) controlling: randomised delay between messages,
  batch size + longer break between batches, hourly and daily caps counted across all campaigns
  on a rolling window, and a send-time window (e.g. only 9h–20h — the runner sleeps and resumes itself).
- **Safety**: auto-pause if >30% of the last 20 sends fail; exponential backoff on rate-limit
  errors with the recipient requeued; immediate pause on token/account errors; opted-out,
  invalid and recently-contacted numbers excluded from every campaign; error 131049 recorded
  as "skipped" rather than failed.
- **Dry run mode**: renders the exact message every recipient would get, sends nothing.
- **Webhook**: receives delivery/read status and inbound replies; a reply matching an opt-out
  keyword (stop / unsubscribe / arrêt / توقف …) permanently unsubscribes that contact.
- **Campaign control**: start / pause / resume / stop, progress persisted to disk so a restart
  doesn't lose place, retry-failed, per-recipient CSV export.

## What I want from you

[REPLACE — e.g. "review my approach for X", "help me write a template that Meta will approve",
"my campaign returns error 132001, why", "how do I warm up a new number", "should I add feature Y"]

Please give me concrete, specific answers. Assume I can read code. Don't suggest unofficial
WhatsApp libraries — I'm deliberately on the official API.
