// Campaign runner: paces sends, enforces caps and quiet hours, retries what is
// worth retrying, and stops itself when things look wrong.
//
// Every recipient's outcome is written to Postgres as it happens, so a crash or
// a deploy loses at most the message in flight.
import { randomUUID } from 'node:crypto';
import {
  settings, getCampaign, updateCampaign, campaignStats,
  pendingRecipients, updateRecipient, getContact, markContactSent,
  logSend, sentSince, claimCampaign, heartbeat, releaseCampaign, currentRunner,
} from './data.js';

import { sendTemplate, sendText, classifyError, ERROR_HINTS } from './whatsapp.js';

/** Identifies this process, so another server can tell it apart from itself. */
export const RUNNER_ID = `${process.env.HOSTNAME || process.env.COMPUTERNAME || 'host'}-${process.pid}-${randomUUID().slice(0, 8)}`;

/** @type {Map<string, {stop:boolean, pause:boolean, note:string, waitingUntil:number|null}>} */
const running = new Map();

export function runtimeState(id) {
  const c = running.get(id);
  return c ? { active: true, note: c.note, waitingUntil: c.waitingUntil } : { active: false };
}

export async function pauseCampaign(id) {
  const c = running.get(id);
  if (c) c.pause = true;
  const camp = await getCampaign(id);
  if (camp?.status === 'running') await updateCampaign(id, { status: 'paused' });
}

export async function stopCampaign(id) {
  const c = running.get(id);
  if (c) c.stop = true;
  const camp = await getCampaign(id);
  if (camp && ['running', 'paused'].includes(camp.status)) await updateCampaign(id, { status: 'stopped' });
}

// ---- text helpers --------------------------------------------------------

/** {a|b|c} -> one of a, b, c. Gives every message a slightly different shape. */
export function spin(text) {
  let out = String(text ?? '');
  let guard = 0;
  while (/\{[^{}]*\|[^{}]*\}/.test(out) && guard++ < 20) {
    out = out.replace(/\{([^{}]*\|[^{}]*)\}/, (_, group) => {
      const opts = group.split('|');
      return opts[Math.floor(Math.random() * opts.length)];
    });
  }
  return out;
}

/**
 * Fill {{field}} placeholders from a contact.
 * Supports a fallback: {{first_name|there}}
 */
export function render(templateStr, contact) {
  return String(templateStr ?? '').replace(/\{\{\s*([^}|]+?)\s*(?:\|\s*([^}]*?)\s*)?\}\}/g, (_, key, fallback) => {
    const k = key.trim();
    let v;
    if (k === 'name') v = contact.name;
    else if (k === 'phone') v = contact.phone;
    else v = contact.fields?.[k] ?? contact.fields?.[k.toLowerCase()];
    if (v === undefined || v === null || String(v).trim() === '') return fallback ?? '';
    return String(v).trim();
  });
}

/** Template parameters may not contain newlines, tabs or 4+ consecutive spaces. */
function sanitizeParam(v) {
  return String(v ?? '').replace(/[\r\n\t]+/g, ' ').replace(/ {4,}/g, '   ').trim();
}

export function buildValue(pattern, contact) {
  return sanitizeParam(spin(render(pattern, contact)));
}

// ---- pacing --------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function interruptibleSleep(ms, ctl, note) {
  const until = Date.now() + ms;
  ctl.waitingUntil = until;
  ctl.note = note;
  while (Date.now() < until) {
    if (ctl.stop || ctl.pause) break;
    await sleep(Math.min(500, until - Date.now()));
  }
  ctl.waitingUntil = null;
}

function insideWindow(t) {
  const { windowStart, windowEnd } = t;
  const h = new Date().getHours();
  if (windowStart === windowEnd) return true;
  if (windowStart < windowEnd) return h >= windowStart && h < windowEnd;
  return h >= windowStart || h < windowEnd; // window crosses midnight
}

function msUntilWindow(t) {
  const now = new Date();
  const next = new Date(now);
  next.setMinutes(0, 5, 0);
  next.setHours(t.windowStart);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next - now;
}

// ---- the loop ------------------------------------------------------------

export async function startCampaign(id) {
  if (running.has(id)) return { ok: false, error: 'Campaign already running.' };
  const camp = await getCampaign(id);
  if (!camp) return { ok: false, error: 'Campaign not found.' };

  // Another server (your laptop vs the host) may already be sending this.
  if (!await claimCampaign(id, RUNNER_ID)) {
    const who = await currentRunner(id);
    return { ok: false, error: `Another server is already sending this campaign${who ? ` (${who})` : ''}. Stop it there first — running both would send every message twice.` };
  }

  const ctl = { stop: false, pause: false, note: 'starting', waitingUntil: null };
  running.set(id, ctl);
  await updateCampaign(id, { status: 'running', startedAt: camp.startedAt || Date.now(), lastError: null });

  loop(camp, ctl)
    .catch(async (err) => {
      console.error(`[${camp.id}] crashed:`, err);
      await updateCampaign(camp.id, { status: 'paused', lastError: err.message }).catch(() => {});
    })
    .finally(async () => {
      running.delete(id);
      await releaseCampaign(id, RUNNER_ID).catch(() => {});
    });

  return { ok: true };
}

async function finish(camp, status, note) {
  const stats = await campaignStats(camp.id);
  await updateCampaign(camp.id, { status, finishedAt: Date.now(), stats, ...(note ? { lastError: note } : {}) });
}

async function loop(camp, ctl) {
  const t = camp.throttle;
  const recent = []; // rolling window of outcomes for the health guard
  let sinceBatchPause = 0;
  let done = 0;

  for (;;) {
    if (ctl.stop) return finish(camp, 'stopped');
    if (ctl.pause) {
      await updateCampaign(camp.id, { status: 'paused', stats: await campaignStats(camp.id) });
      return;
    }

    // Pull the queue in pages so a 100k campaign doesn't sit in memory.
    const batch = await pendingRecipients(camp.id, 100);
    if (!batch.length) break;

    for (const r of batch) {
      if (ctl.stop) return finish(camp, 'stopped');
      if (ctl.pause) {
        await updateCampaign(camp.id, { status: 'paused', stats: await campaignStats(camp.id) });
        return;
      }

      const contact = (r.contactId && await getContact(r.contactId)) || { name: r.name, phone: r.phone, fields: {} };

      // --- pre-flight guards ---------------------------------------------
      if (contact.optOut) { await updateRecipient(r.id, { status: 'skipped', error: 'opted out', at: Date.now() }); continue; }
      if (contact.invalid) { await updateRecipient(r.id, { status: 'skipped', error: 'number marked invalid', at: Date.now() }); continue; }

      if (t.respectWindow && !insideWindow(t)) {
        const wait = msUntilWindow(t);
        await interruptibleSleep(wait, ctl, `outside send window — resuming in ${(wait / 3600000).toFixed(1)}h`);
        break; // re-read the queue when the window opens
      }
      if (await sentSince(24 * 3600 * 1000) >= t.dailyCap) {
        await interruptibleSleep(15 * 60 * 1000, ctl, 'daily cap reached — waiting for the 24h window to roll');
        break;
      }
      if (await sentSince(3600 * 1000) >= t.hourlyCap) {
        await interruptibleSleep(10 * 60 * 1000, ctl, 'hourly cap reached — cooling down');
        break;
      }

      // --- send -----------------------------------------------------------
      done++;
      ctl.note = `sending ${done} of this run`;
      const attempts = (r.attempts || 0) + 1;

      try {
        if (camp.dryRun) {
          await updateRecipient(r.id, {
            status: 'sent', attempts, messageId: 'DRY-RUN', at: Date.now(),
            preview: buildPreview(camp, contact), error: null,
          });
        } else {
          const res = await dispatch(camp, contact, r);
          await updateRecipient(r.id, {
            status: 'sent', attempts, messageId: res?.messages?.[0]?.id || null, at: Date.now(), error: null,
          });
          await logSend(r.phone, camp.id, true);
          if (r.contactId) await markContactSent(r.contactId);
        }
        recent.push(true);
        sinceBatchPause++;
      } catch (err) {
        const cls = classifyError(err);
        const info = { error: err.message, code: Number(err.code) || null, hint: ERROR_HINTS[Number(err.code)] || null, attempts };

        if (cls.kind === 'skip') {
          await updateRecipient(r.id, { ...info, status: 'skipped', at: Date.now() });
        } else if (cls.kind === 'auth' || cls.kind === 'account') {
          await updateRecipient(r.id, { ...info, status: 'pending' });
          return finish(camp, 'paused', `${err.message} — campaign auto-paused.`);
        } else if (cls.kind === 'throttle') {
          const giveUp = attempts >= 6;
          await updateRecipient(r.id, { ...info, status: giveUp ? 'failed' : 'pending' });
          recent.push(false);
          if (!giveUp) {
            const backoff = Math.min(30, 2 ** Math.min(attempts, 5)) * 60 * 1000;
            await interruptibleSleep(backoff, ctl, `rate limited (${err.code}) — backing off ${Math.round(backoff / 60000)}m`);
          }
        } else if (cls.retry && attempts < 3) {
          await updateRecipient(r.id, { ...info, status: 'pending' });
          await interruptibleSleep(20_000, ctl, 'transient error — retrying');
        } else {
          await updateRecipient(r.id, { ...info, status: 'failed', at: Date.now() });
          if (!camp.dryRun) await logSend(r.phone, camp.id, false);
          recent.push(false);
        }
        sinceBatchPause++;
      }

      // --- health guard ---------------------------------------------------
      if (recent.length > 20) recent.shift();
      if (recent.length >= 10) {
        const failRate = recent.filter((x) => !x).length / recent.length;
        if (failRate >= (t.autoPauseFailureRate || 0.3)) {
          return finish(camp, 'paused', `Auto-paused: ${Math.round(failRate * 100)}% of the last ${recent.length} sends failed. Check the log before resuming.`);
        }
      }

      await heartbeat(camp.id, RUNNER_ID);
      if (done % 5 === 0) await updateCampaign(camp.id, { stats: await campaignStats(camp.id) });

      // --- pace -----------------------------------------------------------
      if (t.batchSize > 0 && sinceBatchPause >= t.batchSize) {
        sinceBatchPause = 0;
        const pauseMs = t.batchPauseMin * 60 * 1000 * (0.75 + Math.random() * 0.5);
        await interruptibleSleep(pauseMs, ctl, `batch of ${t.batchSize} done — pausing ${Math.round(pauseMs / 60000)}m`);
      } else {
        const min = Math.max(1, t.minDelaySec);
        const max = Math.max(min, t.maxDelaySec);
        const delay = (min + Math.random() * (max - min)) * 1000;
        await interruptibleSleep(delay, ctl, `waiting ${Math.round(delay / 1000)}s before next message`);
      }
    }
  }

  if (ctl.stop) return finish(camp, 'stopped');
  if (ctl.pause) {
    await updateCampaign(camp.id, { status: 'paused', stats: await campaignStats(camp.id) });
    return;
  }
  return finish(camp, 'done');
}

/**
 * A mapping entry is { name, pattern }. Campaigns created before named-parameter
 * support stored plain strings, which were positional — keep those working.
 */
function resolveMap(map = [], contact) {
  return map.map((entry, i) => (typeof entry === 'string'
    ? { name: String(i + 1), text: buildValue(entry, contact) }
    : { name: entry.name, text: buildValue(entry.pattern, contact) }));
}

function dispatch(camp, contact, r) {
  if (camp.mode === 'text') {
    const variant = camp.textVariants[Math.floor(Math.random() * camp.textVariants.length)];
    return sendText(r.phone, spin(render(variant, contact)));
  }
  const m = camp.template;
  return sendTemplate({
    to: r.phone,
    template: m.name,
    language: m.language,
    named: !!m.named,
    bodyParams: resolveMap(m.bodyMap, contact),
    headerParams: resolveMap(m.headerMap, contact),
    headerMedia: m.headerMedia?.link ? m.headerMedia : null,
    buttonParams: (m.buttonMap || []).map((b) => ({ ...b, value: buildValue(b.value, contact) })),
  });
}

export function buildPreview(camp, contact) {
  if (camp.mode === 'text') {
    const variant = camp.textVariants?.[0] || '';
    return spin(render(variant, contact));
  }
  const m = camp.template || {};
  const parts = [];
  const show = (map) => resolveMap(map, contact).map((p) => `{{${p.name}}} = ${p.text}`).join('  ·  ');
  if (m.headerMap?.length) parts.push(`[header] ${show(m.headerMap)}`);
  if (m.headerMedia?.link) parts.push(`[${m.headerMedia.type}] ${m.headerMedia.link}`);
  parts.push(`${m.name} (${m.language}) → ${show(m.bodyMap) || 'no variables'}`);
  return parts.join('\n');
}

export { settings };
