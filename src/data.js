// Postgres (Supabase) data layer. Replaces the JSON file store.
//
// Settings are cached in memory because they are read on almost every request
// and written rarely. Everything else goes to the database on every call, so
// two processes can never overwrite each other's work.
import { createClient } from '@supabase/supabase-js';

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_KEY;

// Don't exit here: the server needs to boot far enough to explain the problem
// in the browser, otherwise a hosting panel just shows a bare 503.
export const configError = !URL
  ? 'SUPABASE_URL is not set.'
  : !KEY
    ? 'SUPABASE_SERVICE_KEY is not set.'
    : null;

export const sb = configError ? null : createClient(URL, KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/** Throw Supabase errors instead of silently returning empty data. */
function unwrap({ data, error }, what) {
  if (error) throw Object.assign(new Error(`${what}: ${error.message}`), { supabase: error });
  return data;
}

/** PostgREST caps a select at 1000 rows; page through it. */
async function fetchAll(build, pageSize = 1000) {
  const out = [];
  for (let from = 0; ; from += pageSize) {
    const rows = unwrap(await build().range(from, from + pageSize - 1), 'read');
    out.push(...rows);
    if (rows.length < pageSize) return out;
  }
}

export const newId = (prefix) => `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

// ---------------------------------------------------------------- settings

const DEFAULT_SETTINGS = {
  phoneNumberId: '',
  wabaId: '',
  accessToken: '',
  apiVersion: 'v22.0',
  verifyToken: '',
  defaultCountryCode: '212',
  minDelaySec: 45,
  maxDelaySec: 120,
  batchSize: 25,
  batchPauseMin: 20,
  dailyCap: 200,
  hourlyCap: 40,
  windowStart: 9,
  windowEnd: 20,
  respectWindow: true,
  autoPauseFailureRate: 0.3,
  optOutKeywords: 'stop,unsubscribe,arret,arrêt,stp stop,désabonner,توقف,الغاء',
};

let cache = { ...DEFAULT_SETTINGS };

export function settings() {
  return cache;
}

export async function loadSettings() {
  const row = unwrap(await sb.from('app_settings').select('data').eq('id', 1).maybeSingle(), 'load settings');
  cache = { ...DEFAULT_SETTINGS, ...(row?.data || {}) };
  return cache;
}

export async function saveSettings(patch) {
  cache = { ...cache, ...patch };
  unwrap(await sb.from('app_settings').upsert({ id: 1, data: cache }).select('id'), 'save settings');
  return cache;
}

// ---------------------------------------------------------------- contacts

const toContact = (r) => ({
  id: r.id,
  phone: r.phone,
  raw: r.raw,
  name: r.name || '',
  fields: r.fields || {},
  tags: r.tags || [],
  optOut: r.opt_out,
  invalid: r.invalid,
  createdAt: r.created_at ? Date.parse(r.created_at) : null,
  lastSentAt: r.last_sent_at ? Date.parse(r.last_sent_at) : null,
});

const LIGHT = 'id,phone,name,tags,opt_out,invalid,last_sent_at';

export async function getContact(id) {
  const row = unwrap(await sb.from('contacts').select('*').eq('id', id).maybeSingle(), 'get contact');
  return row ? toContact(row) : null;
}

export async function listContacts({ q = '', tag = '', status = '', limit = 500 } = {}) {
  let query = sb.from('contacts').select('*').order('created_at', { ascending: false });
  if (q) query = query.or(`phone.ilike.%${q}%,name.ilike.%${q}%`);
  if (tag) query = query.contains('tags', [tag]);
  if (status === 'optout') query = query.eq('opt_out', true);
  if (status === 'invalid') query = query.eq('invalid', true);
  if (status === 'active') query = query.eq('opt_out', false).eq('invalid', false);
  const rows = unwrap(await query.limit(limit), 'list contacts');
  return rows.map(toContact);
}

export async function contactSummary({ q = '', tag = '', status = '' } = {}) {
  const count = async (build) => {
    const { count: n, error } = await build;
    if (error) throw new Error(error.message);
    return n || 0;
  };
  let filtered = sb.from('contacts').select('id', { count: 'exact', head: true });
  if (q) filtered = filtered.or(`phone.ilike.%${q}%,name.ilike.%${q}%`);
  if (tag) filtered = filtered.contains('tags', [tag]);
  if (status === 'optout') filtered = filtered.eq('opt_out', true);
  if (status === 'invalid') filtered = filtered.eq('invalid', true);
  if (status === 'active') filtered = filtered.eq('opt_out', false).eq('invalid', false);

  const [total, grandTotal, optOuts, invalid] = await Promise.all([
    count(filtered),
    count(sb.from('contacts').select('id', { count: 'exact', head: true })),
    count(sb.from('contacts').select('id', { count: 'exact', head: true }).eq('opt_out', true)),
    count(sb.from('contacts').select('id', { count: 'exact', head: true }).eq('invalid', true)),
  ]);
  return { total, grandTotal, optOuts, invalid };
}

export async function allTags() {
  const rows = await fetchAll(() => sb.from('contacts').select('tags'));
  return [...new Set(rows.flatMap((r) => r.tags || []))].sort();
}

export async function phonesThatExist(phones) {
  const found = new Set();
  for (let i = 0; i < phones.length; i += 300) {
    const chunk = phones.slice(i, i + 300);
    const rows = unwrap(await sb.from('contacts').select('phone').in('phone', chunk), 'check phones');
    for (const r of rows) found.add(r.phone);
  }
  return found;
}

/** Insert new contacts and merge into existing ones, matched on phone. */
export async function upsertContacts(rows, { tags = [], updateExisting = true } = {}) {
  const result = { added: 0, updated: 0, skipped: 0 };
  const valid = rows.filter((r) => r.valid && r.phone);
  result.skipped = rows.length - valid.length;

  // Last occurrence of a phone wins, matching the old file-based behaviour.
  const byPhone = new Map();
  for (const r of valid) byPhone.set(r.phone, r);

  // Look these up in chunks: `in(...)` on thousands of values blows the URL length.
  const phones = [...byPhone.keys()];
  const existingByPhone = new Map();
  for (let i = 0; i < phones.length; i += 300) {
    const rows = unwrap(
      await sb.from('contacts').select('id,phone,name,fields,tags').in('phone', phones.slice(i, i + 300)),
      'find existing',
    );
    for (const row of rows) existingByPhone.set(row.phone, row);
  }

  const inserts = [];
  const updates = [];
  for (const [phone, r] of byPhone) {
    const prev = existingByPhone.get(phone);
    if (prev) {
      if (!updateExisting) { result.skipped++; continue; }
      updates.push({
        id: prev.id,
        phone,
        name: r.name || prev.name,
        fields: { ...(prev.fields || {}), ...(r.fields || {}) },
        tags: [...new Set([...(prev.tags || []), ...tags])],
      });
    } else {
      inserts.push({
        id: newId('c'),
        phone,
        raw: r.raw || '',
        name: r.name || '',
        fields: r.fields || {},
        tags: [...new Set([...(r.tags || []), ...tags])],
      });
    }
  }

  for (let i = 0; i < inserts.length; i += 500) {
    unwrap(await sb.from('contacts').insert(inserts.slice(i, i + 500)).select('id'), 'insert contacts');
  }
  for (let i = 0; i < updates.length; i += 500) {
    unwrap(await sb.from('contacts').upsert(updates.slice(i, i + 500)).select('id'), 'update contacts');
  }
  result.added = inserts.length;
  result.updated = updates.length;
  return result;
}

export async function updateContact(id, patch) {
  const row = {};
  if (patch.name !== undefined) row.name = patch.name;
  if (patch.optOut !== undefined) { row.opt_out = !!patch.optOut; row.opt_out_at = patch.optOut ? new Date().toISOString() : null; }
  if (patch.invalid !== undefined) row.invalid = !!patch.invalid;
  if (patch.tags !== undefined) row.tags = patch.tags;
  if (patch.lastSentAt !== undefined) row.last_sent_at = new Date(patch.lastSentAt).toISOString();
  const out = unwrap(await sb.from('contacts').update(row).eq('id', id).select('*'), 'update contact');
  return out[0] ? toContact(out[0]) : null;
}

export async function markContactSent(id) {
  unwrap(await sb.from('contacts').update({ last_sent_at: new Date().toISOString() }).eq('id', id).select('id'), 'mark sent');
}

export async function bulkContacts(ids, action, tag) {
  if (!ids.length) return { ok: true };
  const chunks = [];
  for (let i = 0; i < ids.length; i += 500) chunks.push(ids.slice(i, i + 500));

  for (const chunk of chunks) {
    if (action === 'delete') {
      unwrap(await sb.from('contacts').delete().in('id', chunk).select('id'), 'delete contacts');
    } else if (action === 'optout' || action === 'optin') {
      const optOut = action === 'optout';
      unwrap(await sb.from('contacts')
        .update({ opt_out: optOut, opt_out_at: optOut ? new Date().toISOString() : null })
        .in('id', chunk).select('id'), 'bulk opt-out');
    } else if ((action === 'tag' || action === 'untag') && tag) {
      // Arrays need a read-modify-write; PostgREST has no array append.
      const rows = unwrap(await sb.from('contacts').select('id,tags').in('id', chunk), 'read tags');
      const next = rows.map((r) => ({
        id: r.id,
        tags: action === 'tag'
          ? [...new Set([...(r.tags || []), tag])]
          : (r.tags || []).filter((t) => t !== tag),
      }));
      if (next.length) unwrap(await sb.from('contacts').upsert(next).select('id'), 'write tags');
    }
  }
  return { ok: true };
}

export async function optOutByPhone(phone) {
  const out = unwrap(await sb.from('contacts')
    .update({ opt_out: true, opt_out_at: new Date().toISOString() })
    .eq('phone', phone).select('id'), 'opt out by phone');
  return out.length > 0;
}

// ---------------------------------------------------------------- audience

/** Candidate pool for a campaign, with a reason for every exclusion. */
export async function audienceBreakdown(audience = {}) {
  const a = audience;
  const rows = await fetchAll(() => sb.from('contacts').select(LIGHT).order('created_at', { ascending: true }));
  const picked = a.ids?.length ? new Set(a.ids) : null;
  const cutoff = a.excludeSentWithinDays ? Date.now() - a.excludeSentWithinDays * 86400000 : 0;
  const excluded = { optOut: 0, invalid: 0, notInTag: 0, notPicked: 0, recentlyContacted: 0, overLimit: 0 };

  let list = rows.map(toContact).filter((c) => {
    if (c.optOut) { excluded.optOut++; return false; }
    if (c.invalid) { excluded.invalid++; return false; }
    if (picked && !picked.has(c.id)) { excluded.notPicked++; return false; }
    if (a.tags?.length && !a.tags.some((t) => c.tags.includes(t))) { excluded.notInTag++; return false; }
    if (cutoff && c.lastSentAt && c.lastSentAt >= cutoff) { excluded.recentlyContacted++; return false; }
    return true;
  });

  if (a.shuffle) list = list.map((c) => [Math.random(), c]).sort((x, y) => x[0] - y[0]).map((x) => x[1]);
  if (a.limit && list.length > a.limit) {
    excluded.overLimit = list.length - a.limit;
    list = list.slice(0, a.limit);
  }
  return { list, excluded, total: rows.length };
}

// --------------------------------------------------------------- campaigns

const toCampaign = (r) => ({
  id: r.id,
  name: r.name,
  status: r.status,
  mode: r.mode,
  template: r.template,
  textVariants: r.text_variants || [],
  audience: r.audience || {},
  throttle: r.throttle || {},
  dryRun: r.dry_run,
  stats: r.stats || {},
  lastError: r.last_error,
  createdAt: r.created_at ? Date.parse(r.created_at) : null,
  startedAt: r.started_at ? Date.parse(r.started_at) : null,
  finishedAt: r.finished_at ? Date.parse(r.finished_at) : null,
});

export async function listCampaigns() {
  const rows = unwrap(await sb.from('campaigns').select('*').order('created_at', { ascending: false }), 'list campaigns');
  return rows.map(toCampaign);
}

export async function getCampaign(id) {
  const row = unwrap(await sb.from('campaigns').select('*').eq('id', id).maybeSingle(), 'get campaign');
  return row ? toCampaign(row) : null;
}

export async function insertCampaign(c) {
  unwrap(await sb.from('campaigns').insert({
    id: c.id,
    name: c.name,
    status: c.status,
    mode: c.mode,
    template: c.template,
    text_variants: c.textVariants,
    audience: c.audience,
    throttle: c.throttle,
    dry_run: c.dryRun,
    stats: c.stats || {},
  }).select('id'), 'create campaign');
  return c;
}

export async function updateCampaign(id, patch) {
  const row = {};
  if (patch.status !== undefined) row.status = patch.status;
  if (patch.stats !== undefined) row.stats = patch.stats;
  if (patch.lastError !== undefined) row.last_error = patch.lastError;
  if (patch.startedAt !== undefined) row.started_at = patch.startedAt ? new Date(patch.startedAt).toISOString() : null;
  if (patch.finishedAt !== undefined) row.finished_at = patch.finishedAt ? new Date(patch.finishedAt).toISOString() : null;
  if (!Object.keys(row).length) return;
  unwrap(await sb.from('campaigns').update(row).eq('id', id).select('id'), 'update campaign');
}

export async function deleteCampaign(id) {
  unwrap(await sb.from('campaigns').delete().eq('id', id).select('id'), 'delete campaign');
}

export async function campaignsByStatus(status) {
  const rows = unwrap(await sb.from('campaigns').select('*').eq('status', status), 'campaigns by status');
  return rows.map(toCampaign);
}

// -------------------------------------------------------------- recipients

const toRecipient = (r) => ({
  id: r.id,
  contactId: r.contact_id,
  phone: r.phone,
  name: r.name || '',
  status: r.status,
  attempts: r.attempts,
  messageId: r.message_id,
  delivery: r.delivery,
  error: r.error,
  code: r.code,
  hint: r.hint,
  preview: r.preview,
  at: r.sent_at ? Date.parse(r.sent_at) : null,
});

export async function insertRecipients(campaignId, contacts) {
  const rows = contacts.map((c, i) => ({
    campaign_id: campaignId,
    contact_id: c.id,
    phone: c.phone,
    name: c.name || '',
    position: i,
  }));
  for (let i = 0; i < rows.length; i += 500) {
    unwrap(await sb.from('recipients').insert(rows.slice(i, i + 500)).select('id'), 'insert recipients');
  }
  return rows.length;
}

export async function listRecipients(campaignId, { status = '', limit = 500 } = {}) {
  let q = sb.from('recipients').select('*').eq('campaign_id', campaignId).order('position');
  if (status) q = q.eq('status', status);
  const rows = unwrap(await q.limit(limit), 'list recipients');
  return rows.map(toRecipient);
}

export async function countRecipients(campaignId, status = '') {
  let q = sb.from('recipients').select('id', { count: 'exact', head: true }).eq('campaign_id', campaignId);
  if (status) q = q.eq('status', status);
  const { count, error } = await q;
  if (error) throw new Error(error.message);
  return count || 0;
}

/** The next people to message, in campaign order. */
export async function pendingRecipients(campaignId, limit = 200) {
  const rows = unwrap(await sb.from('recipients').select('*')
    .eq('campaign_id', campaignId).eq('status', 'pending')
    .order('position').limit(limit), 'pending recipients');
  return rows.map(toRecipient);
}

export async function updateRecipient(id, patch) {
  const row = {};
  if (patch.status !== undefined) row.status = patch.status;
  if (patch.attempts !== undefined) row.attempts = patch.attempts;
  if (patch.messageId !== undefined) row.message_id = patch.messageId;
  if (patch.delivery !== undefined) row.delivery = patch.delivery;
  if (patch.error !== undefined) row.error = patch.error;
  if (patch.code !== undefined) row.code = patch.code;
  if (patch.hint !== undefined) row.hint = patch.hint;
  if (patch.preview !== undefined) row.preview = patch.preview;
  if (patch.at !== undefined) row.sent_at = patch.at ? new Date(patch.at).toISOString() : null;
  unwrap(await sb.from('recipients').update(row).eq('id', id).select('id'), 'update recipient');
}

export async function requeueFailed(campaignId) {
  const rows = unwrap(await sb.from('recipients')
    .update({ status: 'pending', attempts: 0, error: null, code: null, hint: null })
    .eq('campaign_id', campaignId).eq('status', 'failed').select('id'), 'requeue failed');
  return rows.length;
}

export async function recipientByMessageId(messageId) {
  const row = unwrap(await sb.from('recipients').select('*').eq('message_id', messageId).maybeSingle(), 'find by wamid');
  return row ? { ...toRecipient(row), campaignId: row.campaign_id } : null;
}

/** Counts for the progress bar, computed in the database. */
export async function campaignStats(campaignId) {
  const rows = await fetchAll(() => sb.from('recipients').select('status,delivery').eq('campaign_id', campaignId));
  return {
    total: rows.length,
    sent: rows.filter((r) => r.status === 'sent').length,
    failed: rows.filter((r) => r.status === 'failed').length,
    skipped: rows.filter((r) => r.status === 'skipped').length,
    pending: rows.filter((r) => r.status === 'pending').length,
    delivered: rows.filter((r) => ['delivered', 'read'].includes(r.delivery)).length,
    read: rows.filter((r) => r.delivery === 'read').length,
  };
}

export async function allRecipientsForExport(campaignId) {
  const rows = await fetchAll(() => sb.from('recipients').select('*').eq('campaign_id', campaignId).order('position'));
  return rows.map(toRecipient);
}

// ---------------------------------------------------------------- send log

export async function logSend(phone, campaignId, ok) {
  unwrap(await sb.from('send_log').insert({ phone, campaign_id: campaignId, ok }).select('id'), 'log send');
}

export async function sentSince(ms) {
  const since = new Date(Date.now() - ms).toISOString();
  const { count, error } = await sb.from('send_log')
    .select('id', { count: 'exact', head: true })
    .gte('sent_at', since).eq('ok', true);
  if (error) throw new Error(error.message);
  return count || 0;
}

export async function sendStats() {
  const [lastHour, last24h] = await Promise.all([sentSince(3600 * 1000), sentSince(24 * 3600 * 1000)]);
  return { lastHour, last24h };
}

// ------------------------------------------------------------------ inbox

export async function addInbound({ from, text, optOut }) {
  unwrap(await sb.from('inbox').insert({ from_phone: from, body: text, opt_out: optOut }).select('id'), 'save inbound');
}

export async function listInbox(limit = 300) {
  const rows = unwrap(await sb.from('inbox').select('*').order('at', { ascending: false }).limit(limit), 'list inbox');
  return rows.map((r) => ({ from: r.from_phone, text: r.body, at: Date.parse(r.at), optOut: r.opt_out }));
}

// --------------------------------------------------------------- sessions

export async function createSession(token, expiresAt) {
  unwrap(await sb.from('sessions').insert({ token, expires_at: new Date(expiresAt).toISOString() }).select('token'), 'create session');
}

export async function sessionValid(token) {
  const row = unwrap(await sb.from('sessions').select('expires_at').eq('token', token).maybeSingle(), 'check session');
  if (!row) return false;
  if (Date.parse(row.expires_at) < Date.now()) {
    await deleteSession(token);
    return false;
  }
  return true;
}

export async function deleteSession(token) {
  unwrap(await sb.from('sessions').delete().eq('token', token).select('token'), 'delete session');
}

export async function deleteAllSessions() {
  unwrap(await sb.from('sessions').delete().neq('token', '').select('token'), 'clear sessions');
}

export async function pruneSessions() {
  await sb.from('sessions').delete().lt('expires_at', new Date().toISOString());
}

/** Fail fast at boot with a clear message rather than on the first request. */
export async function checkConnection() {
  if (configError) {
    throw new Error([
      configError,
      'Set SUPABASE_URL and SUPABASE_SERVICE_KEY as environment variables.',
      "Locally that is a .env file; on a host, the panel's environment section.",
    ].join('\n  '));
  }
  const { error } = await sb.from('app_settings').select('id').limit(1);
  if (error) {
    throw new Error(
      `Cannot reach your Supabase database: ${error.message}\n`
      + '  • Check SUPABASE_URL and SUPABASE_SERVICE_KEY in .env\n'
      + '  • Make sure you ran supabase/schema.sql in the SQL editor\n'
      + '  • A free-tier project pauses after ~7 days idle — unpause it in the dashboard',
    );
  }
}

// -------------------------------------------------- conversations (replies)

const WINDOW_MS = 24 * 3600 * 1000;

/** Meta only allows free text within 24h of the contact's last message. */
export function windowOpen(lastInboundAt) {
  return !!lastInboundAt && Date.now() - lastInboundAt < WINDOW_MS;
}

/** One row per person who has ever written to you, newest activity first. */
export async function listConversations(limit = 100) {
  const rows = await fetchAll(() => sb.from('inbox').select('*').order('at', { ascending: false }));

  const threads = new Map();
  for (const r of rows) {
    const key = r.from_phone;
    if (!threads.has(key)) {
      threads.set(key, { phone: key, lastAt: Date.parse(r.at), lastText: r.body, lastDirection: r.direction, messages: 0, inbound: 0 });
    }
    const t = threads.get(key);
    t.messages++;
    if (r.direction === 'in') {
      t.inbound++;
      if (!t.lastInboundAt) t.lastInboundAt = Date.parse(r.at);
    }
  }

  const list = [...threads.values()].sort((a, b) => b.lastAt - a.lastAt).slice(0, limit);
  if (!list.length) return [];

  // Attach the contact record so the UI can show names and opt-out state.
  const contacts = unwrap(
    await sb.from('contacts').select('id,phone,name,tags,opt_out,unread_count').in('phone', list.map((t) => t.phone)),
    'conversation contacts',
  );
  const byPhone = new Map(contacts.map((c) => [c.phone, c]));

  return list.map((t) => {
    const c = byPhone.get(t.phone);
    return {
      ...t,
      contactId: c?.id || null,
      name: c?.name || '',
      tags: c?.tags || [],
      optOut: !!c?.opt_out,
      unread: c?.unread_count || 0,
      windowOpen: windowOpen(t.lastInboundAt),
      windowClosesAt: t.lastInboundAt ? t.lastInboundAt + WINDOW_MS : null,
    };
  });
}

export async function conversationMessages(phone, limit = 200) {
  const rows = unwrap(
    await sb.from('inbox').select('*').eq('from_phone', phone).order('at', { ascending: true }).limit(limit),
    'conversation messages',
  );
  return rows.map((r) => ({
    id: r.id,
    direction: r.direction || 'in',
    text: r.body,
    at: Date.parse(r.at),
    status: r.status,
    type: r.msg_type || 'text',
  }));
}

export async function addMessage({ phone, text, direction, messageId = null, status = null, type = 'text', optOut = false }) {
  unwrap(await sb.from('inbox').insert({
    from_phone: phone, body: text, direction, message_id: messageId, status, msg_type: type, opt_out: optOut,
  }).select('id'), 'save message');
}

export async function touchInbound(phone) {
  const now = new Date().toISOString();
  const rows = unwrap(await sb.from('contacts').select('id,unread_count').eq('phone', phone).limit(1), 'find contact');
  if (!rows.length) return null;
  unwrap(await sb.from('contacts')
    .update({ last_inbound_at: now, unread_count: (rows[0].unread_count || 0) + 1 })
    .eq('id', rows[0].id).select('id'), 'touch inbound');
  return rows[0].id;
}

export async function markRead(phone) {
  unwrap(await sb.from('contacts').update({ unread_count: 0 }).eq('phone', phone).select('id'), 'mark read');
}

export async function contactByPhone(phone) {
  const row = unwrap(await sb.from('contacts').select('*').eq('phone', phone).maybeSingle(), 'contact by phone');
  if (!row) return null;
  return { ...toContact(row), lastInboundAt: row.last_inbound_at ? Date.parse(row.last_inbound_at) : null, unread: row.unread_count || 0 };
}

export async function updateMessageStatus(messageId, status) {
  await sb.from('inbox').update({ status }).eq('message_id', messageId);
}

export async function totalUnread() {
  const rows = await fetchAll(() => sb.from('contacts').select('unread_count').gt('unread_count', 0));
  return rows.reduce((n, r) => n + (r.unread_count || 0), 0);
}

// ------------------------------------------------------------- dashboard

/** Everything the overview screen needs, in one round of queries. */
export async function overview() {
  const count = async (q) => { const { count: n, error } = await q; if (error) throw new Error(error.message); return n || 0; };
  const dayAgo = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const weekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();

  const [contacts, optOuts, invalid, sent24, sent7d, failed7d, replies7d] = await Promise.all([
    count(sb.from('contacts').select('id', { count: 'exact', head: true })),
    count(sb.from('contacts').select('id', { count: 'exact', head: true }).eq('opt_out', true)),
    count(sb.from('contacts').select('id', { count: 'exact', head: true }).eq('invalid', true)),
    count(sb.from('send_log').select('id', { count: 'exact', head: true }).gte('sent_at', dayAgo).eq('ok', true)),
    count(sb.from('send_log').select('id', { count: 'exact', head: true }).gte('sent_at', weekAgo).eq('ok', true)),
    count(sb.from('send_log').select('id', { count: 'exact', head: true }).gte('sent_at', weekAgo).eq('ok', false)),
    count(sb.from('inbox').select('id', { count: 'exact', head: true }).gte('at', weekAgo).eq('direction', 'in')),
  ]);

  // Delivery funnel across every recipient ever queued.
  const recips = await fetchAll(() => sb.from('recipients').select('status,delivery'));
  const funnel = {
    queued: recips.length,
    sent: recips.filter((r) => r.status === 'sent').length,
    delivered: recips.filter((r) => ['delivered', 'read'].includes(r.delivery)).length,
    read: recips.filter((r) => r.delivery === 'read').length,
    failed: recips.filter((r) => r.status === 'failed').length,
    skipped: recips.filter((r) => r.status === 'skipped').length,
  };

  // Daily sends for the last 14 days, for the sparkline.
  const log = await fetchAll(() => sb.from('send_log').select('sent_at,ok').gte('sent_at', new Date(Date.now() - 14 * 86400000).toISOString()));
  const byDay = new Map();
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    byDay.set(d, 0);
  }
  for (const e of log) {
    if (!e.ok) continue;
    const d = e.sent_at.slice(0, 10);
    if (byDay.has(d)) byDay.set(d, byDay.get(d) + 1);
  }

  const campaigns = unwrap(await sb.from('campaigns').select('*').order('created_at', { ascending: false }).limit(5), 'recent campaigns');

  return {
    contacts: { total: contacts, optOuts, invalid, reachable: contacts - optOuts - invalid },
    sending: { last24h: sent24, last7d: sent7d, failed7d },
    replies: { last7d: replies7d, unread: await totalUnread() },
    funnel,
    daily: [...byDay.entries()].map(([date, n]) => ({ date, count: n })),
    recentCampaigns: campaigns.map(toCampaign),
  };
}

// ------------------------------------------------------- schema versioning

let migrationNeeded = null;

/** True when supabase/002-conversations.sql has not been run yet. */
export async function needsConversationMigration() {
  if (migrationNeeded !== null) return migrationNeeded;
  const { error } = await sb.from('inbox').select('direction').limit(1);
  migrationNeeded = !!(error && /does not exist/i.test(error.message));
  return migrationNeeded;
}

export function resetMigrationCheck() { migrationNeeded = null; }

// --------------------------------------------------- cross-instance locking
//
// Your laptop and your server share this database. Without a lock, both would
// happily run the same campaign and every client would get the message twice.

export const STALE_MS = 3 * 60 * 1000; // a runner that misses 3 minutes is dead

let lockSupported = null;

async function locksAvailable() {
  if (lockSupported !== null) return lockSupported;
  const { error } = await sb.from('campaigns').select('runner_id').limit(1);
  lockSupported = !(error && /does not exist/i.test(error.message));
  return lockSupported;
}

/** Take ownership of a campaign. False means another live server has it. */
export async function claimCampaign(id, runnerId) {
  if (!await locksAvailable()) return true; // migration not run yet — behave as before
  const now = new Date().toISOString();
  const cutoff = new Date(Date.now() - STALE_MS).toISOString();
  const claim = { runner_id: runnerId, heartbeat: now };

  // Free to take?
  let out = unwrap(await sb.from('campaigns').update(claim).eq('id', id).is('runner_id', null).select('id'), 'claim campaign');
  if (out.length) return true;

  // Previous runner died?
  out = unwrap(await sb.from('campaigns').update(claim).eq('id', id).lt('heartbeat', cutoff).select('id'), 'reclaim campaign');
  if (out.length) return true;

  // Already ours (same process restarting the loop)?
  out = unwrap(await sb.from('campaigns').update(claim).eq('id', id).eq('runner_id', runnerId).select('id'), 'refresh claim');
  return out.length > 0;
}

export async function heartbeat(id, runnerId) {
  if (!await locksAvailable()) return;
  await sb.from('campaigns').update({ heartbeat: new Date().toISOString() }).eq('id', id).eq('runner_id', runnerId);
}

export async function releaseCampaign(id, runnerId) {
  if (!await locksAvailable()) return;
  await sb.from('campaigns').update({ runner_id: null, heartbeat: null }).eq('id', id).eq('runner_id', runnerId);
}

/** Who, if anyone, is actively sending this campaign. */
export async function currentRunner(id) {
  if (!await locksAvailable()) return null;
  const row = unwrap(await sb.from('campaigns').select('runner_id,heartbeat').eq('id', id).maybeSingle(), 'read runner');
  if (!row?.runner_id || !row.heartbeat) return null;
  if (Date.parse(row.heartbeat) < Date.now() - STALE_MS) return null;
  return row.runner_id;
}

/** Interrupted campaigns this instance may safely pick up. */
export async function campaignsToResume() {
  const running = await campaignsByStatus('running');
  // Without the lock columns we cannot tell whether another server owns this
  // campaign. Auto-resuming on a guess would double-send, so don't: a human
  // pressing Resume is a deliberate act, an automatic restart is not.
  if (!await locksAvailable()) {
    if (running.length) {
      console.warn(`  ${running.length} interrupted campaign(s) NOT auto-resumed — run supabase/003-runner-lock.sql to enable safe resume.`);
    }
    return [];
  }
  const cutoff = Date.now() - STALE_MS;
  const rows = unwrap(await sb.from('campaigns').select('id,runner_id,heartbeat').eq('status', 'running'), 'resume scan');
  const stale = new Set(rows.filter((r) => !r.heartbeat || Date.parse(r.heartbeat) < cutoff).map((r) => r.id));
  return running.filter((c) => stale.has(c.id));
}
