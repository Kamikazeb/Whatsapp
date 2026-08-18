# Setup, click by click

Two sides to this: **what you do on Meta's websites** (once), and **what you do in the app**
(every campaign). Do them in this order.

---

# PART A — Meta side (once, ~30 minutes)

There are three different Meta websites and that is the main source of confusion:

| Site | What it's for |
|---|---|
| **developers.facebook.com** | your app, the phone number ID, the webhook |
| **business.facebook.com** | your business, the permanent token, **your message templates** |
| business.facebook.com → Account Quality | your number's health once you start sending |

---

## A1. Get your two IDs

**developers.facebook.com** → your app → left menu **WhatsApp → API Setup**.

On that page you'll see:

- **Phone number ID** — a long number under your phone number. ← copy this
- **WhatsApp Business Account ID** — just below it. ← copy this too

Ignore the "Temporary access token" at the top of this page. It stops working after 24 hours.

## A2. Make a token that doesn't expire

**business.facebook.com** → gear icon (**Business settings**) → **Users → System users**

1. **Add** → name it `sender` → role **Admin** → Create.
2. Select it → **Assign assets**. Do this **twice** — it is two separate assets:
   - **Apps** → tick your WhatsApp app → **Full control** → Save
   - **WhatsApp accounts** → tick your WhatsApp Business Account → **Full control** → Save
3. **Generate new token** → choose your app → **Token expiration: Never** → tick these two permissions:
   - `whatsapp_business_messaging` (sending)
   - `whatsapp_business_management` (reading your templates)
4. **Generate token** → copy it now. Meta shows it once. It starts with `EAA` and is very long.

> Skipping either half of step 2 is the usual reason a brand-new token still returns error 190
> or 200. Missing the *WhatsApp accounts* half specifically gives you a token that connects but
> lists no templates.

## A3. Write your promotion template

This is the step that most people miss, and nothing sends without it.

**Rule:** if a client has not sent *you* a WhatsApp message in the last 24 hours, the only
thing you are allowed to send them is a template Meta approved beforehand. There is no way
around this — it's enforced by the API, not by the app.

**business.facebook.com** → **WhatsApp Manager** → **Message templates** → **Create template**

- **Category: Marketing** (Utility is for order updates and will be rejected for promos)
- **Name:** lowercase with underscores, e.g. `promo_aout_2026`
- **Language:** the one your clients read — French, Arabic, English… (you can add more later)
- **Body:** write the offer, and put `{{1}}` where the client's name goes:

```
Bonjour {{1}}, -20% sur toute la collection jusqu'au 31 août chez [your shop].
Répondez STOP pour ne plus recevoir nos offres.
```

- Meta asks for a **sample value** for `{{1}}` — type any name, e.g. `Ahmed`.
- Optionally add a button (Visit website / Call) — buttons lift response a lot.

**Submit.** Approval is usually 5–60 minutes. Watch the status column: `APPROVED` = ready,
`REJECTED` = click it to see why (usually: too vague, misleading, or missing context).

Two things that materially reduce bans, both free:
- the **STOP line** — it converts an annoyed person into a reply this app handles, instead of a *Report*
- naming your business in the text so nobody wonders who is messaging them

## A4. Know your limit

**business.facebook.com** → **Account Quality** (or the WhatsApp Manager overview).

A brand-new number starts at **250 different people per 24 hours**. It moves to 1,000 → 10,000
→ 100,000 automatically as you send without getting blocked. Your daily cap in the app must
stay under your current tier, otherwise you just generate errors.

The same screen shows your **quality rating**: green / yellow / red. Red twice and Meta cuts
your limit; keep going and the number gets disabled. Quality is driven almost entirely by
people pressing **Block** and **Report** — not by how fast you send.

---

# PART B — App side

## B1. Start it

```bash
npm start
```

Open <http://localhost:3000>. You land on **Start here**.

## B2. Steps 2 and 3 on the Start here tab

- Paste the **phone number ID**, **business account ID**, **token**, and your country code
  (`212` for Morocco) → **Save & test connection**.
  Green means the token works — it shows your number, its quality rating and its 24h limit.
- Press **Check my templates**. Your approved template from A3 should be listed. If it isn't,
  it's still under review, or the token is missing `whatsapp_business_management`.

## B3. Replies (step 4 — optional, do it before your first real campaign)

Meta needs a public HTTPS address to push replies to, and your app is on localhost, so open a
tunnel. In a **second terminal**:

```bash
cloudflared tunnel --url http://localhost:3000
```

It prints a URL like `https://random-words-1234.trycloudflare.com`. Then:

**developers.facebook.com** → your app → **WhatsApp → Configuration** → **Webhook → Edit**
- Callback URL: that URL + `/webhook`
- Verify token: whatever is shown in step 4 of the app
- **Verify and save** → then **Manage** → tick **messages** → Done.

Now you get delivered/read ticks in the app, and anyone replying STOP is unsubscribed
automatically. (The tunnel URL changes each time you restart cloudflared — re-paste it.)

## B4. Import your clients — Contacts tab

Drop your CSV or Excel file, tag the batch (`clients-2026`), press **Preview import**.
You'll see exactly what will be saved: how each number was rewritten (`0612345678` →
`+212612345678`), which rows are unusable, which are duplicates. Nothing is stored until you
press **Import valid rows**.

Every extra column in your file is kept and becomes usable in messages as `{{column_name}}`.

## B5. Send tab

1. **What to send** — pick your approved template. If it has `{{1}}`, set it to `{{name|client}}`
   (the client's name, or the word "client" when you don't have their name). Press
   **Show me a real example** to see the finished message for a real contact.
2. **Who gets it** — choose a tag, or leave empty for everyone. Opted-out and invalid numbers
   are never included.
3. **How fast** — pick **Careful** for your first campaigns. The line underneath tells you in
   plain words what will happen and how long it will take.

Leave **Test run** ticked and press **Create campaign** → **Start sending**. Nothing is sent;
the app writes out the exact message each person would have received. Read a few in **Details**.

Happy with it? Untick **Test run**, create it again for real, and start.

## B6. While it runs — Results tab

Live counters, a line telling you what the sender is doing right now ("waiting 47s before next
message", "batch done — pausing 20m"), and per-recipient errors in plain language.
You can pause and resume at any time; closing the app or rebooting doesn't lose progress.

---

# When something goes wrong

| What you see | What it means |
|---|---|
| `190` / not connected | Token expired or missing permissions — redo A2 including the *Assign assets* step |
| `132001` template does not exist | Name or language mismatch — check `fr` vs `fr_FR` in WhatsApp Manager |
| `131026` undeliverable | That number isn't on WhatsApp. Normal on any list; the app marks it and moves on |
| `131047` re-engagement required | You tried free text on someone outside the 24h window — use a template |
| `131049` | Meta is limiting marketing to that person today. Counted as *skipped*, they'll get the next one |
| `131048` spam rate limit | You're being throttled. The app backs off automatically — but slow down and reread your message |
| `132015` template paused | Too many people blocked after that template. Rewrite it |
| Quality goes yellow/red | Stop sending for a few days. Cut the list to your most engaged clients only |

**If the number gets restricted:** stop everything, go to Account Quality, request a review,
and don't send again until it's green. Sending through a restriction is what turns a warning
into a permanent ban.
