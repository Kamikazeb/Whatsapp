# Putting this online

Read PART 0 before anything else. Then follow **either** Part A or Part B, depending on your
Hostinger plan.

## Which plan do you have?

Log into **hPanel** and look at your hosting plan:

| Plan | Can it run this app? |
|---|---|
| **Business web hosting** | Yes — Part A |
| **Cloud hosting** (any tier) | Yes — Part A |
| **VPS** | Yes — Part B (most reliable) |
| **Premium / shared web hosting** | **No.** Those plans run PHP only. Uploading these files does nothing — there is no Node process to execute them. Upgrade to Business, or take a small VPS. |

Look for a **Node.js** / "Node.js app" section in hPanel. If it isn't there, your plan can't host this.

---

# PART 0 — Before you upload anything

## 0.1 Set the login password

The app now refuses to work until a password exists. Two ways:

- **Recommended for hosting:** set `APP_PASSWORD` as an environment variable on the server
  (see the steps below). It never touches the database.
- Or leave it unset and choose one in the browser on first visit; the app stores a scrypt hash.

Without this, anyone who finds your URL can export all your client numbers and send messages
on your WhatsApp number until it is banned.

## 0.2 Set up the database (do this first)

The app stores everything in Supabase now, not in files. Two things, in this order:

1. **Rotate your service_role key** — Supabase → Project Settings → API → service_role → Reset.
2. **Create the tables** — Supabase → SQL Editor → New query → paste all of
   `supabase/schema.sql` → Run.

You can do both before uploading anything. The database is independent of the hosting.

## 0.3 Move your existing contacts across

The migration runs from **your own computer**, not the server — it reads your local
`data/db.json` and writes to Supabase over the internet. So it works whether or not the app
is deployed yet.

With `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` filled into your local `.env`:

```bash
node scripts/migrate-to-supabase.mjs
```

That previews only. Add `--commit` to write. Do this **before** your first real campaign on
the server, or the deployed app will start with an empty contact list.

Your WhatsApp token and login password are deliberately not migrated — you set those again.

## 0.4 Decide what to upload

**Upload:**
```
src/  public/  scripts/  supabase/  package.json  package-lock.json
```

**Do NOT upload:**
- `node_modules/` — installed on the server with `npm install`
- `.env` — set the values in the hosting panel instead (on a VPS, create it on the server)
- `data/` — no longer used by the app at all. Keep it locally as your fallback copy.

## 0.5 Environment variables you will set on the server

| Name | Required | Value |
|---|---|---|
| `SUPABASE_URL` | **yes** | `https://YOUR-PROJECT.supabase.co` |
| `SUPABASE_SERVICE_KEY` | **yes** | the rotated service_role key. The app will not start without it |
| `APP_PASSWORD` | recommended | your login password. Leave unset to choose one in the browser |
| `WA_ACCESS_TOKEN` | recommended | the permanent Meta token; keeps it out of the database |
| `WA_PHONE_NUMBER_ID` | | from Meta API Setup |
| `WA_BUSINESS_ACCOUNT_ID` | | from Meta API Setup |
| `WA_VERIFY_TOKEN` | | any random string, also typed into Meta's webhook screen |
| `WA_APP_SECRET` | recommended | Meta dashboard → Settings → Basic → App secret. Rejects forged webhooks |
| `DEFAULT_COUNTRY_CODE` | | `212` |
| `NODE_ENV` | | `production` |

Anything not set as an env var can still be typed into the Start here tab after deploying —
except the two Supabase ones, which the app needs before it can boot.

---

# PART A — Business or Cloud hosting (hPanel)

1. **hPanel → Websites → your site → Node.js** (or "Node.js app").
2. Create an application:
   - **Node version:** 20 or newer (the app needs 20+)
   - **Application root:** where you uploaded the files
   - **Startup file:** `src/server.js`
   - Do **not** hardcode a port — the panel provides `PORT` and the app reads it.
3. **Upload the files** (File Manager or FTP) per step 0.4, then run **npm install** from the
   Node.js panel (or its terminal).
4. Add every environment variable from 0.5 in the panel's environment section — at minimum the two Supabase ones.
5. Start the app, then open your domain. You should get the sign-in screen.

**Two things to watch on shared-style plans:**

- **Idle shutdown.** If the panel stops your app when no one is browsing, a long campaign
  stops with it. The app now auto-resumes when it starts again, but a campaign that should take
  6 hours will stretch out unpredictably. If that happens, use a VPS (Part B).
- **Disk persistence no longer matters.** Everything lives in Supabase, so a redeploy that wipes
  the app directory costs you nothing but the upload.

---

# PART B — VPS

Assumes Ubuntu 22.04/24.04 and a domain (or subdomain) pointed at the VPS IP.

## B1. Node 22 + pm2

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs nginx
sudo npm install -g pm2
```

## B2. Put the app on the server

```bash
sudo mkdir -p /var/www/wa-sender && sudo chown $USER:$USER /var/www/wa-sender
cd /var/www/wa-sender
```

Upload `src/`, `public/`, `scripts/`, `supabase/`, `package.json`, `package-lock.json` here (SFTP/scp), then:

```bash
npm install --omit=dev
```

## B3. Environment file

```bash
nano /var/www/wa-sender/.env
```

Paste the variables from 0.5 (one `NAME=value` per line), save, then lock it down:

```bash
chmod 600 /var/www/wa-sender/.env
```

## B4. Run it under pm2

```bash
cd /var/www/wa-sender
pm2 start src/server.js --name wa-sender
pm2 startup
pm2 save
```

`pm2 startup` prints one command — run it. That is what brings the app back after a reboot,
and the app then auto-resumes any campaign that was mid-send.

Useful later: `pm2 logs wa-sender`, `pm2 restart wa-sender`, `pm2 status`.

## B5. nginx + HTTPS

```bash
sudo nano /etc/nginx/sites-available/wa-sender
```

```nginx
server {
    listen 80;
    server_name sender.yourdomain.com;

    client_max_body_size 30M;   # contact file uploads

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/wa-sender /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d sender.yourdomain.com
```

Certbot installs the certificate and the renewal timer. The app reads `X-Forwarded-Proto`, so
the session cookie is automatically marked `Secure` once you are on HTTPS.

## B6. Firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
```

Port 3000 must **not** be open to the internet — only nginx talks to it.

---

# PART C — After it is live

## C1. Point the webhook at the real URL

No more tunnel. In **developers.facebook.com → your app → WhatsApp → Configuration → Webhook**:

- Callback URL: `https://sender.yourdomain.com/webhook`
- Verify token: your `WA_VERIFY_TOKEN`
- Then **Manage** → tick **messages**

The webhook path is deliberately public (Meta has no way to log in), but with `WA_APP_SECRET`
set, anything without a valid Meta signature is rejected with 403.

## C2. Back ups

Supabase takes automatic daily backups (Dashboard → Database → Backups), so the cron-tarball
approach is no longer needed. Two things still worth doing:

- Export your contacts occasionally from the app, or from Supabase's table editor, so you hold
  a copy of your client list outside any one provider.
- On the free tier a project **pauses after ~7 days with no activity**. A paused database means
  the app cannot start or send. Unpause it from the dashboard, or move to a paid tier once this
  is doing real work.

## C3. Sanity checks on the live site

1. You get a sign-in screen, not the app. (If you see the app without signing in, stop and fix it.)
2. `https://` with a valid padlock.
3. Start here → step 2 shows **connected** with your number and quality rating.
4. Step 4 shows **receiving replies** after Meta verifies the webhook.
5. Run one campaign with **Test run** ticked before sending anything real.

## C4. Ongoing

- Update: upload changed files → `npm install --omit=dev` if dependencies changed → `pm2 restart wa-sender`.
- Rotate the login password from time to time; changing it signs out every device.
- If the Meta token is ever exposed, revoke it in Business settings → System users and issue a new one.
