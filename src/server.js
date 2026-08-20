import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as data from './data.js';
import { settings, saveSettings, newId } from './data.js';
import { normalizePhone } from './phone.js';
import { parseFile, parseCsv, mapRows } from './import.js';
import { listTemplates, describeTemplate, getPhoneNumberHealth, getToken, tokenFromEnv, sendText, ERROR_HINTS } from './whatsapp.js';
import { startCampaign, pauseCampaign, stopCampaign, runtimeState, buildPreview } from './sender.js';
import { mountAuthRoutes, requireAuth, verifyWebhookSignature, passwordIsSet } from './auth.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// IMPORTANT: this file must contain no top-level `await`.
//
// LiteSpeed (Hostinger's Node runtime) loads the entry file with require(), and
// require() refuses any ES module whose graph uses top-level await:
//   ERR_REQUIRE_ASYNC_MODULE ... use import() instead
// It fails before a single line executes, so the app never even logs. Startup
// therefore runs inside an async function while the module itself stays sync.
let bootError = null;
let booted = false;

async function boot() {
  try {
    // Settings must be in memory before anything reads them.
    await data.checkConnection();
    await data.loadSettings();

    // Seed configuration from .env on first run; the UI is the source of truth after.
    const s = settings();
    const env = process.env;
    const patch = {};
    if (!s.phoneNumberId && env.WA_PHONE_NUMBER_ID) patch.phoneNumberId = env.WA_PHONE_NUMBER_ID;
    if (!s.wabaId && env.WA_BUSINESS_ACCOUNT_ID) patch.wabaId = env.WA_BUSINESS_ACCOUNT_ID;
    if (!s.verifyToken) patch.verifyToken = env.WA_VERIFY_TOKEN || 'change-me';
    if (env.WA_API_VERSION) patch.apiVersion = env.WA_API_VERSION;
    if (!s.defaultCountryCode && env.DEFAULT_COUNTRY_CODE) patch.defaultCountryCode = env.DEFAULT_COUNTRY_CODE;
    // WA_ACCESS_TOKEN is deliberately never stored — see getToken() in whatsapp.js.
    if (Object.keys(patch).length) await saveSettings(patch);

    booted = true;
  } catch (err) {
    bootError = err.message;
    console.error(`\n  STARTUP FAILED\n  ${err.message}\n`);
  }
}

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

app.set('trust proxy', 1); // behind nginx / hPanel
app.use(express.json({ limit: '10mb', verify: (req, res, buf) => { req.rawBody = buf; } }));

/**
 * Reachable without a session and before anything else, so a 503 can be told
 * apart from "the app is up but misconfigured". Deliberately leaks nothing:
 * booleans and a variable name at most.
 */
app.get('/healthz', (req, res) => {
  res.type('application/json').send(JSON.stringify({
    ok: !bootError,
    boot: bootError || 'ok',
    node: process.version,
    uptimeSeconds: Math.round(process.uptime()),
    databaseConfigured: !data.configError,
  }, null, 2));
});

// Nothing else can work without the database, so answer every request with the
// reason. Names of missing variables only — never their values.
app.use((req, res, next) => {
  if (booted) return next();
  if (!bootError) {
    // Requests can land in the fraction of a second before boot() resolves.
    return res.status(503).type('text/plain; charset=utf-8')
      .send('Starting up — reload in a moment.\n');
  }
  res.status(503).type('text/plain; charset=utf-8').send(
    `WhatsApp Sender cannot start.\n\n${bootError}\n\n`
    + 'Set these in your hosting panel\'s environment section, then restart the app:\n'
    + '  SUPABASE_URL           https://YOUR-PROJECT.supabase.co\n'
    + '  SUPABASE_SERVICE_KEY   the service_role key from Supabase → Settings → API\n',
  );
});

mountAuthRoutes(app);
app.use(requireAuth);
app.use(express.static(path.join(ROOT, 'public')));

app.get('/SETUP.md', (req, res) => res.type('text/plain; charset=utf-8').sendFile(path.join(ROOT, 'SETUP.md')));

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch((err) => {
  res.status(err.status && err.status < 600 ? err.status : 500).json({
    error: err.message,
    code: err.code ?? null,
    details: err.details ?? null,
  });
});

// ---------------------------------------------------------------- settings

function publicSettings() {
  const { accessToken, authHash, authSalt, ...rest } = settings();
  const token = getToken();
  return {
    ...rest,
    accessTokenSet: !!token,
    accessTokenTail: token ? `…${token.slice(-6)}` : '',
    accessTokenFromEnv: tokenFromEnv(),
  };
}

app.get('/api/settings', (req, res) => res.json(publicSettings()));

app.post('/api/settings', wrap(async (req, res) => {
  const incoming = { ...req.body };
  if (!incoming.accessToken) delete incoming.accessToken;      // blank = keep current
  if (tokenFromEnv()) delete incoming.accessToken;             // env always wins
  delete incoming.authHash;
  delete incoming.authSalt;
  for (const k of ['minDelaySec', 'maxDelaySec', 'batchSize', 'batchPauseMin', 'dailyCap', 'hourlyCap', 'windowStart', 'windowEnd']) {
    if (incoming[k] !== undefined) incoming[k] = Number(incoming[k]);
  }
  await saveSettings(incoming);
  res.json(publicSettings());
}));

app.get('/api/health', wrap(async (req, res) => {
  const info = await getPhoneNumberHealth();
  res.json({ ...info, ...(await data.sendStats()) });
}));

app.get('/api/setup-status', wrap(async (req, res) => {
  const s = settings();
  const out = {
    credentials: !!(s.phoneNumberId && getToken()),
    wabaId: !!s.wabaId,
    connected: false,
    number: null,
    error: null,
    templates: null,
    webhookSeen: s.webhookSeen || null,
    ...(await data.sendStats()),
  };
  if (out.credentials) {
    try {
      out.number = await getPhoneNumberHealth();
      out.connected = true;
    } catch (err) {
      out.error = err.message;
    }
  }
  if (out.connected && s.wabaId) {
    try {
      const list = await listTemplates();
      out.templates = { total: list.length, approved: list.filter((t) => t.status === 'APPROVED').length };
    } catch { /* not fatal for setup */ }
  }
  res.json(out);
}));

app.get('/api/templates', wrap(async (req, res) => {
  const list = await listTemplates();
  res.json(list.map((t) => ({ ...t, shape: describeTemplate(t) })));
}));

// ---------------------------------------------------------------- contacts

app.get('/api/contacts', wrap(async (req, res) => {
  const filter = { q: String(req.query.q || ''), tag: String(req.query.tag || ''), status: String(req.query.status || '') };
  const [items, summary, tags] = await Promise.all([
    data.listContacts(filter),
    data.contactSummary(filter),
    data.allTags(),
  ]);
  res.json({ ...summary, tags, items });
}));

// Step 1 of import: show what was parsed before touching the database.
app.post('/api/contacts/preview', upload.single('file'), wrap(async (req, res) => {
  let rows;
  if (req.file) rows = await parseFile(req.file.buffer, req.file.originalname);
  else if (req.body.text) rows = parseCsv(req.body.text);
  else throw Object.assign(new Error('Nothing to import.'), { status: 400 });

  const mapped = mapRows(rows, {
    phoneCol: req.body.phoneCol || null,
    nameCol: req.body.nameCol || null,
    defaultCountryCode: settings().defaultCountryCode,
  });

  const valid = mapped.rows.filter((r) => r.valid).map((r) => r.phone);
  const existing = await data.phonesThatExist([...new Set(valid)]);
  const seen = new Set();
  let dupInFile = 0;
  for (const r of mapped.rows) {
    if (!r.valid) continue;
    if (seen.has(r.phone)) { r.duplicateInFile = true; dupInFile++; }
    seen.add(r.phone);
    r.alreadyExists = existing.has(r.phone);
  }

  res.json({
    headers: mapped.headers,
    phoneCol: mapped.phoneCol,
    nameCol: mapped.nameCol,
    counts: {
      total: mapped.rows.length,
      valid: mapped.rows.filter((r) => r.valid).length,
      invalid: mapped.rows.filter((r) => !r.valid).length,
      duplicateInFile: dupInFile,
      alreadyExists: mapped.rows.filter((r) => r.alreadyExists).length,
    },
    sample: mapped.rows.slice(0, 25),
    rows: mapped.rows,
  });
}));

app.post('/api/contacts/import', wrap(async (req, res) => {
  const { rows = [], tags = [], updateExisting = true } = req.body;
  const result = await data.upsertContacts(rows, { tags, updateExisting });
  res.json(result);
}));

app.post('/api/contacts/quick-add', wrap(async (req, res) => {
  const raw = String(req.body.numbers || '');
  const tags = req.body.tags || [];
  const cc = settings().defaultCountryCode;
  const parsed = [];
  const invalid = [];

  for (const line of raw.split(/[\n,;]+/)) {
    const piece = line.trim();
    if (!piece) continue;
    // "212600000000 Ahmed" — anything after the number is treated as the name.
    const m = piece.match(/^([+\d\s()\-.]+)\s*(.*)$/);
    const r = normalizePhone(m ? m[1] : piece, cc);
    if (!r.ok) { invalid.push(piece); continue; }
    parsed.push({ valid: true, phone: r.phone, raw: piece, name: (m?.[2] || '').trim(), fields: {}, tags: [] });
  }

  const before = new Set(await data.phonesThatExist(parsed.map((p) => p.phone)));
  const out = await data.upsertContacts(parsed, { tags, updateExisting: false });
  res.json({ added: out.added, duplicate: before.size, invalid });
}));

app.patch('/api/contacts/:id', wrap(async (req, res) => {
  const c = await data.updateContact(req.params.id, req.body);
  if (!c) return res.status(404).json({ error: 'Not found' });
  res.json(c);
}));

app.post('/api/contacts/bulk', wrap(async (req, res) => {
  const { ids = [], action, tag } = req.body;
  await data.bulkContacts(ids, action, tag);
  res.json({ ok: true });
}));

// --------------------------------------------------------------- campaigns

app.post('/api/campaigns/audience-count', wrap(async (req, res) => {
  const { list, excluded, total } = await data.audienceBreakdown(req.body.audience);
  res.json({
    count: list.length,
    total,
    excluded,
    sample: list.slice(0, 12).map((c) => ({ name: c.name, phone: c.phone, tags: c.tags })),
  });
}));

app.get('/api/campaigns', wrap(async (req, res) => {
  const list = await data.listCampaigns();
  res.json(list.map((c) => ({ ...c, runtime: runtimeState(c.id) })));
}));

app.post('/api/campaigns', wrap(async (req, res) => {
  const b = req.body;
  const { list } = await data.audienceBreakdown(b.audience);
  if (!list.length) return res.status(400).json({ error: 'Audience is empty.' });

  const t = { ...settings(), ...(b.throttle || {}) };
  const camp = {
    id: newId('camp'),
    name: b.name || `Campaign ${new Date().toLocaleString()}`,
    status: 'draft',
    mode: b.mode === 'text' ? 'text' : 'template',
    template: b.template || null,
    textVariants: (b.textVariants || []).filter(Boolean),
    audience: b.audience || {},
    dryRun: !!b.dryRun,
    throttle: {
      minDelaySec: Number(t.minDelaySec), maxDelaySec: Number(t.maxDelaySec),
      batchSize: Number(t.batchSize), batchPauseMin: Number(t.batchPauseMin),
      dailyCap: Number(t.dailyCap), hourlyCap: Number(t.hourlyCap),
      respectWindow: !!t.respectWindow, windowStart: Number(t.windowStart), windowEnd: Number(t.windowEnd),
      autoPauseFailureRate: Number(t.autoPauseFailureRate) || 0.3,
    },
    stats: { total: list.length, sent: 0, failed: 0, skipped: 0, pending: list.length, delivered: 0, read: 0 },
  };
  if (camp.mode === 'text' && !camp.textVariants.length) return res.status(400).json({ error: 'Add at least one message variant.' });
  if (camp.mode === 'template' && !camp.template?.name) return res.status(400).json({ error: 'Pick a template.' });

  await data.insertCampaign(camp);
  await data.insertRecipients(camp.id, list);
  res.json(camp);
}));

app.get('/api/campaigns/:id', wrap(async (req, res) => {
  const camp = await data.getCampaign(req.params.id);
  if (!camp) return res.status(404).json({ error: 'Not found' });
  const status = String(req.query.status || '');
  const [stats, recipients, recipientTotal] = await Promise.all([
    data.campaignStats(camp.id),
    data.listRecipients(camp.id, { status }),
    data.countRecipients(camp.id, status),
  ]);
  res.json({ ...camp, stats, runtime: runtimeState(camp.id), recipients, recipientTotal });
}));

app.post('/api/campaigns/:id/start', wrap(async (req, res) => {
  const out = await startCampaign(req.params.id);
  if (!out.ok) return res.status(400).json(out);
  res.json({ ok: true });
}));

app.post('/api/campaigns/:id/pause', wrap(async (req, res) => { await pauseCampaign(req.params.id); res.json({ ok: true }); }));
app.post('/api/campaigns/:id/stop', wrap(async (req, res) => { await stopCampaign(req.params.id); res.json({ ok: true }); }));

app.post('/api/campaigns/:id/retry-failed', wrap(async (req, res) => {
  const camp = await data.getCampaign(req.params.id);
  if (!camp) return res.status(404).json({ error: 'Not found' });
  const requeued = await data.requeueFailed(camp.id);
  await data.updateCampaign(camp.id, { status: 'paused', stats: await data.campaignStats(camp.id) });
  res.json({ requeued });
}));

app.delete('/api/campaigns/:id', wrap(async (req, res) => {
  await stopCampaign(req.params.id);
  await data.deleteCampaign(req.params.id); // recipients cascade
  res.json({ ok: true });
}));

app.get('/api/campaigns/:id/export', wrap(async (req, res) => {
  const camp = await data.getCampaign(req.params.id);
  if (!camp) return res.status(404).json({ error: 'Not found' });
  const rows = await data.allRecipientsForExport(camp.id);
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [
    'phone,name,status,delivery,message_id,attempts,error,sent_at',
    ...rows.map((r) => [r.phone, r.name, r.status, r.delivery, r.messageId, r.attempts, r.error, r.at ? new Date(r.at).toISOString() : ''].map(esc).join(',')),
  ].join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${camp.id}.csv"`);
  res.send('﻿' + csv);
}));

// Live preview of what one contact will actually receive.
app.post('/api/preview', wrap(async (req, res) => {
  let contact = req.body.contactId ? await data.getContact(req.body.contactId) : null;
  if (!contact) contact = (await data.listContacts({ limit: 1 }))[0];
  if (!contact) contact = { name: 'Ahmed', phone: '212600000000', fields: { city: 'Casablanca' } };
  res.json({ contact: { name: contact.name, phone: contact.phone }, preview: buildPreview(req.body, contact) });
}));

app.get('/api/inbox', wrap(async (req, res) => res.json(await data.listInbox())));

// --------------------------------------------------------------- dashboard

app.get('/api/overview', wrap(async (req, res) => {
  // A pending migration only costs you the reply figures — report everything else.
  const needsMigration = await data.needsConversationMigration();
  const out = await data.overview(!needsMigration);
  out.needsMigration = needsMigration;
  out.migrationFile = needsMigration ? 'supabase/002-conversations.sql' : null;
  // Quality rating and tier come from Meta, not from us.
  try {
    const health = await getPhoneNumberHealth();
    out.number = {
      display: health.display_phone_number,
      name: health.verified_name,
      quality: health.quality_rating,
      tier: health.messaging_limit_tier,
    };
  } catch (err) {
    out.number = null;
    out.numberError = err.message;
  }
  res.json(out);
}));

// ----------------------------------------------------------- conversations

app.get('/api/conversations', wrap(async (req, res) => {
  if (await data.needsConversationMigration()) return res.json([]);
  res.json(await data.listConversations());
}));

app.get('/api/conversations/:phone', wrap(async (req, res) => {
  const phone = String(req.params.phone).replace(/\D/g, '');
  const [messages, contact] = await Promise.all([
    data.conversationMessages(phone),
    data.contactByPhone(phone),
  ]);
  const lastInbound = messages.filter((m) => m.direction === 'in').pop();
  res.json({
    phone,
    contact,
    messages,
    windowOpen: data.windowOpen(lastInbound?.at),
    windowClosesAt: lastInbound ? lastInbound.at + 24 * 3600 * 1000 : null,
  });
}));

app.post('/api/conversations/:phone/read', wrap(async (req, res) => {
  await data.markRead(String(req.params.phone).replace(/\D/g, ''));
  res.json({ ok: true });
}));

/**
 * Free-text reply. Only reaches people who messaged you in the last 24 hours —
 * outside that window Meta rejects it (error 131047) and only a template works.
 */
app.post('/api/conversations/:phone/reply', wrap(async (req, res) => {
  const phone = String(req.params.phone).replace(/\D/g, '');
  const text = String(req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Nothing to send.' });

  const messages = await data.conversationMessages(phone);
  const lastInbound = messages.filter((m) => m.direction === 'in').pop();
  if (!data.windowOpen(lastInbound?.at)) {
    return res.status(400).json({
      error: 'The 24-hour reply window has closed for this contact. Only an approved template can reach them now.',
    });
  }

  try {
    const out = await sendText(phone, text);
    const wamid = out?.messages?.[0]?.id || null;
    await data.addMessage({ phone, text, direction: 'out', messageId: wamid, status: 'sent' });
    res.json({ ok: true, messageId: wamid });
  } catch (err) {
    await data.addMessage({ phone, text, direction: 'out', status: 'failed' });
    res.status(400).json({ error: err.message, code: err.code ?? null, hint: ERROR_HINTS[Number(err.code)] || null });
  }
}));

// ----------------------------------------------------------------- webhook

app.get('/webhook', wrap(async (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === settings().verifyToken) {
    await saveSettings({ webhookSeen: Date.now() });
    return res.status(200).send(req.query['hub.challenge']);
  }
  res.sendStatus(403);
}));

app.post('/webhook', (req, res) => {
  if (!verifyWebhookSignature(req)) {
    console.warn('Rejected webhook with a bad signature.');
    return res.sendStatus(403);
  }
  res.sendStatus(200); // ack fast, then process
  handleWebhook(req.body).catch((err) => console.error('webhook error', err));
});

async function handleWebhook(body) {
  await saveSettings({ webhookSeen: Date.now() });
  for (const entry of body?.entry || []) {
    for (const change of entry.changes || []) {
      const v = change.value || {};
      for (const st of v.statuses || []) await recordStatus(st);
      for (const msg of v.messages || []) await recordInbound(msg);
    }
  }
}

async function recordStatus(st) {
  // Replies you sent from the Conversations tab live in the message log, not
  // in a campaign, so update both and stop at whichever matches.
  await data.updateMessageStatus(st.id, st.status);

  const row = await data.recipientByMessageId(st.id);
  if (!row) return;
  const patch = { delivery: st.status };
  if (st.status === 'failed') {
    patch.status = 'failed';
    patch.error = st.errors?.[0]?.title || 'delivery failed';
    patch.code = st.errors?.[0]?.code ?? null;
  }
  await data.updateRecipient(row.id, patch);
  await data.updateCampaign(row.campaignId, { stats: await data.campaignStats(row.campaignId) });
}

async function recordInbound(msg) {
  const from = msg.from;
  const text = (msg.text?.body || msg.button?.text || '').trim().toLowerCase();
  const keywords = String(settings().optOutKeywords || '').split(',').map((k) => k.trim().toLowerCase()).filter(Boolean);
  const isOptOut = keywords.some((k) => text === k || text.startsWith(`${k} `) || text.includes(k));

  if (isOptOut) {
    await data.optOutByPhone(from);
    console.log(`OPT-OUT from ${from}: "${text}"`);
  }
  await data.addMessage({
    phone: from,
    text: msg.text?.body || msg.button?.text || `[${msg.type}]`,
    direction: 'in',
    messageId: msg.id || null,
    type: msg.type || 'text',
    optOut: isOptOut,
  });
  // Opens the 24-hour window in which you may reply with free text.
  await data.touchInbound(from);
}

// -------------------------------------------------------------------------

/**
 * Two copies of this app would both run the same campaigns and double-send.
 * Refuse to start if another one is already alive.
 */
const LOCK_FILE = path.join(ROOT, '.instance.lock');
const HOST_ID = process.env.HOSTNAME || process.env.COMPUTERNAME || 'unknown-host';

function claimSingleInstance() {
  // This file is only a hint. It must NEVER stop the app from booting: on shared
  // hosting the recorded PID may belong to another tenant's process (or simply be
  // recycled), and refusing to start would take the whole site down for a reason
  // that is probably wrong. Double-sending is prevented properly by the per-campaign
  // lease in Postgres (claimCampaign), which works across machines.
  try {
    const { pid, host } = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
    const sameHost = !host || host === HOST_ID;
    if (pid && pid !== process.pid && sameHost) {
      let alive = false;
      try { process.kill(pid, 0); alive = true; } catch { alive = false; }
      if (alive) {
        console.warn(`\n  Another copy of this app may be running here (process ${pid}).`);
        console.warn('  Campaigns are still safe — each one is leased in the database — but');
        console.warn('  stop the other copy if you did not mean to run two.\n');
      }
    }
  } catch { /* no lock file, or unreadable: fine */ }

  try {
    fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, host: HOST_ID, startedAt: Date.now() }));
  } catch (err) {
    // Some hosts mount the app directory read-only. Losing the lock is not worth
    // refusing to boot over — the danger it guards against is a second live copy,
    // and that case is still caught above by the PID check.
    console.warn(`  Could not write ${LOCK_FILE} (${err.code}); single-instance check disabled.`);
    return;
  }
  const release = () => {
    try {
      const { pid } = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
      if (pid === process.pid) fs.unlinkSync(LOCK_FILE);
    } catch { /* already gone */ }
  };
  process.on('exit', release);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { release(); process.exit(0); });
}

/** A campaign still marked "running" means the process died mid-send. */
async function resumeInterrupted() {
  const stuck = await data.campaignsToResume();
  for (const camp of stuck) {
    console.log(`Resuming interrupted campaign "${camp.name}".`);
    await startCampaign(camp.id).catch((err) => console.error('resume failed', err));
  }
}

claimSingleInstance();

const PORT = process.env.PORT || 3000;

// Listen immediately, then finish booting in the background. The port has to be
// open right away or LiteSpeed considers the app dead.
const server = app.listen(PORT, () => {
  console.log(`\n  WhatsApp Sender running → http://localhost:${PORT}`);

  boot().then(() => {
    if (bootError) {
      console.log('  Database: UNAVAILABLE — every page will explain why.\n');
      return;
    }
    console.log('  Database: Supabase');
    if (!passwordIsSet()) console.log('  No password set yet — open the app and choose one.');
    console.log('');
    resumeInterrupted().catch((err) => console.error(err));
  });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already taken — something else is listening there.`);
    console.error('  Stop it, or start this app on another port:  PORT=3001 npm start\n');
    process.exit(1);
  }
  throw err;
});
