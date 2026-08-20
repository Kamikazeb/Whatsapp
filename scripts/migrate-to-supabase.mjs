// One-off migration: data/db.json (+ data/campaigns/*.json) -> Supabase.
//
//   node scripts/migrate-to-supabase.mjs           preview only, writes nothing
//   node scripts/migrate-to-supabase.mjs --commit  actually write
//
// Safe to run twice: contacts are matched on phone, campaigns on id.
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB_FILE = path.join(ROOT, 'data', 'db.json');
const CAMPAIGN_DIR = path.join(ROOT, 'data', 'campaigns');
const COMMIT = process.argv.includes('--commit');

if (!fs.existsSync(DB_FILE)) {
  console.log('No data/db.json found — nothing to migrate. You are starting fresh.');
  process.exit(0);
}

const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_KEY in .env first.');
  process.exit(1);
}
const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

const check = ({ error }, what) => { if (error) throw new Error(`${what}: ${error.message}`); };
const iso = (ms) => (ms ? new Date(ms).toISOString() : null);

const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
const contacts = db.contacts || [];
const campaigns = db.campaigns || [];

console.log(`Found in data/db.json:`);
console.log(`  ${contacts.length} contacts (${contacts.filter((c) => c.optOut).length} opted out)`);
console.log(`  ${campaigns.length} campaigns`);
console.log(`  ${(db.sendLog || []).length} send-log entries`);
console.log(`  ${(db.inbox || []).length} inbox messages`);
console.log(`  settings: ${db.settings?.phoneNumberId ? 'configured' : 'empty'}`);

let recipientTotal = 0;
for (const c of campaigns) {
  const f = path.join(CAMPAIGN_DIR, `${c.id}.json`);
  if (fs.existsSync(f)) recipientTotal += JSON.parse(fs.readFileSync(f, 'utf8')).length;
}
console.log(`  ${recipientTotal} campaign recipients`);

if (!COMMIT) {
  console.log('\nPreview only. Re-run with --commit to write this to Supabase.');
  process.exit(0);
}

console.log('\nWriting to Supabase…');

// ---- settings (never carry the WhatsApp token or password hash across) ----
const { accessToken, authHash, authSalt, ...safeSettings } = db.settings || {};
// Only fill in blanks. The database is authoritative once the app has run, so
// re-running this must never overwrite live settings (a verify token you already
// gave to Meta, pacing you have tuned) with stale values from the old JSON file.
const { data: existingRow } = await sb.from('app_settings').select('data').eq('id', 1).maybeSingle();
const existing = existingRow?.data || {};
const merged = { ...safeSettings, ...existing };
const kept = Object.keys(existing).filter((k) => safeSettings[k] !== undefined && safeSettings[k] !== existing[k]);
check(await sb.from('app_settings').upsert({ id: 1, data: merged }).select('id'), 'settings');
if (kept.length) console.log(`  kept existing values for: ${kept.join(', ')}`);
console.log('  settings ✓  (access token and password NOT copied — set them again)');

// ---- contacts ----
const rows = contacts.map((c) => ({
  id: c.id,
  phone: c.phone,
  raw: c.raw || '',
  name: c.name || '',
  fields: c.fields || {},
  tags: c.tags || [],
  opt_out: !!c.optOut,
  opt_out_at: iso(c.optOutAt),
  invalid: !!c.invalid,
  created_at: iso(c.createdAt) || new Date().toISOString(),
  last_sent_at: iso(c.lastSentAt),
}));
for (let i = 0; i < rows.length; i += 500) {
  check(await sb.from('contacts').upsert(rows.slice(i, i + 500), { onConflict: 'phone' }).select('id'), 'contacts');
  process.stdout.write(`\r  contacts ${Math.min(i + 500, rows.length)}/${rows.length}`);
}
console.log(`\r  contacts ${rows.length}/${rows.length} ✓            `);

// ---- campaigns + recipients ----
for (const c of campaigns) {
  check(await sb.from('campaigns').upsert({
    id: c.id,
    name: c.name,
    status: c.status,
    mode: c.mode,
    template: c.template,
    text_variants: c.textVariants || [],
    audience: c.audience || {},
    throttle: c.throttle || {},
    dry_run: !!c.dryRun,
    stats: c.stats || {},
    last_error: c.lastError,
    created_at: iso(c.createdAt),
    started_at: iso(c.startedAt),
    finished_at: iso(c.finishedAt),
  }).select('id'), `campaign ${c.name}`);

  const f = path.join(CAMPAIGN_DIR, `${c.id}.json`);
  if (!fs.existsSync(f)) continue;

  // Replace rather than append, so re-running does not duplicate the queue.
  check(await sb.from('recipients').delete().eq('campaign_id', c.id).select('id'), 'clear recipients');

  const recips = JSON.parse(fs.readFileSync(f, 'utf8')).map((r, i) => ({
    campaign_id: c.id,
    contact_id: r.contactId,
    phone: r.phone,
    name: r.name || '',
    status: r.status,
    attempts: r.attempts || 0,
    message_id: r.messageId,
    delivery: r.delivery,
    error: r.error,
    code: Number.isFinite(Number(r.code)) ? Number(r.code) : null,
    hint: r.hint,
    preview: r.preview,
    sent_at: iso(r.at),
    position: i,
  }));
  for (let i = 0; i < recips.length; i += 500) {
    check(await sb.from('recipients').insert(recips.slice(i, i + 500)).select('id'), 'recipients');
  }
  console.log(`  campaign "${c.name}" ✓ (${recips.length} recipients)`);
}

// ---- send log + inbox ----
const log = (db.sendLog || []).map((e) => ({
  sent_at: iso(e.at), phone: e.phone, campaign_id: e.campaignId, ok: !!e.ok,
}));
for (let i = 0; i < log.length; i += 500) check(await sb.from('send_log').insert(log.slice(i, i + 500)).select('id'), 'send log');
if (log.length) console.log(`  send log ✓ (${log.length})`);

const inbox = (db.inbox || []).map((m) => ({
  from_phone: m.from, body: m.text, opt_out: !!m.optOut, at: iso(m.at),
}));
for (let i = 0; i < inbox.length; i += 500) check(await sb.from('inbox').insert(inbox.slice(i, i + 500)).select('id'), 'inbox');
if (inbox.length) console.log(`  inbox ✓ (${inbox.length})`);

console.log('\nDone. Two things to redo in the app:');
console.log('  1. your WhatsApp access token (step 2 on Start here)');
console.log('  2. your login password (you will be asked on first visit)');
console.log('\nYour old data/ folder is untouched — keep it until you have checked everything.');
