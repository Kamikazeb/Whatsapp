// Meta WhatsApp Cloud API client.
import { settings as appSettings } from './data.js';

function missingConfig(msg) {
  return Object.assign(new Error(msg), { status: 400 });
}

/** Environment wins over the stored value, so hosted deploys keep the token out of the database. */
export function getToken() {
  return process.env.WA_ACCESS_TOKEN || appSettings().accessToken || '';
}

export const tokenFromEnv = () => !!process.env.WA_ACCESS_TOKEN;

function cfg() {
  const s = appSettings();
  const accessToken = getToken();
  if (!accessToken) throw missingConfig('No access token configured (step 2 on Start here).');
  if (!s.phoneNumberId) throw missingConfig('No phone number ID configured (step 2 on Start here).');
  return { ...s, accessToken };
}

function base(version) {
  return `https://graph.facebook.com/${version || appSettings().apiVersion || 'v22.0'}`;
}

async function call(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!res.ok) {
    const err = body?.error || {};
    const e = new Error(err.error_user_msg || err.message || `HTTP ${res.status}`);
    e.status = res.status;
    e.code = err.code;
    e.subcode = err.error_subcode;
    e.details = err.error_data?.details;
    e.body = body;
    throw e;
  }
  return body;
}

// ---- templates -----------------------------------------------------------

export async function listTemplates() {
  const s = cfg();
  if (!s.wabaId) throw missingConfig('No WhatsApp Business Account ID configured (Settings tab).');
  const url = `${base()}/${s.wabaId}/message_templates?limit=200&access_token=${encodeURIComponent(s.accessToken)}`;
  const body = await call(url);
  return (body.data || []).map((t) => ({
    name: t.name,
    language: t.language,
    status: t.status,
    category: t.category,
    // Meta templates use either positional {{1}} or named {{order_id}} placeholders.
    // Which one is fixed when the template is created and changes the send payload.
    parameterFormat: (t.parameter_format || 'POSITIONAL').toUpperCase(),
    quality: t.quality_score?.score || null,
    components: t.components || [],
  }));
}

/** Placeholder tokens in a component's text, in order of first appearance. */
export function extractVars(text = '') {
  const out = [];
  for (const m of String(text).matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  // Positional templates must be sent in numeric order regardless of how they appear.
  return out.every((t) => /^\d+$/.test(t)) ? out.sort((a, b) => a - b) : out;
}

export function countVars(text = '') {
  return extractVars(text).length;
}

/** Describe what a template needs so the UI can render the right mapping inputs. */
export function describeTemplate(tpl) {
  const named = tpl.parameterFormat === 'NAMED';
  const out = { named, headerType: null, bodyTokens: [], headerTokens: [], buttons: [] };
  for (const c of tpl.components || []) {
    if (c.type === 'BODY') out.bodyTokens = extractVars(c.text);
    if (c.type === 'HEADER') {
      out.headerType = (c.format || 'TEXT').toUpperCase();
      if (out.headerType === 'TEXT') out.headerTokens = extractVars(c.text);
    }
    if (c.type === 'BUTTONS') {
      out.buttons = (c.buttons || []).map((b, i) => ({
        index: i,
        type: b.type,
        text: b.text,
        // Dynamic URL buttons carry a placeholder suffix that needs a parameter.
        urlVars: b.type === 'URL' ? countVars(b.url) : 0,
      }));
    }
  }
  return out;
}

// ---- sending -------------------------------------------------------------

/**
 * Positional templates take bare values in order; named templates require the
 * placeholder name on each parameter. Sending the wrong shape gives error 132000.
 */
function textParams(params, named) {
  return params.map((p) => (named
    ? { type: 'text', parameter_name: p.name, text: String(p.text ?? '') }
    : { type: 'text', text: String(p.text ?? '') }));
}

/**
 * Send a template message.
 * @param {object} o
 * @param {string} o.to               destination in E.164 digits
 * @param {string} o.template         template name
 * @param {string} o.language         template language code, e.g. 'fr' or 'ar'
 * @param {boolean} o.named           true when the template uses {{named}} placeholders
 * @param {{name:string,text:string}[]} o.bodyParams    body placeholder values
 * @param {{name:string,text:string}[]} o.headerParams  TEXT header placeholder values
 * @param {object} o.headerMedia      { type:'image'|'video'|'document', link }
 * @param {object[]} o.buttonParams   [{ index, subType:'url'|'quick_reply', value }]
 */
export async function sendTemplate(o) {
  const s = cfg();
  const components = [];

  if (o.headerMedia?.link) {
    const t = o.headerMedia.type;
    components.push({ type: 'header', parameters: [{ type: t, [t]: { link: o.headerMedia.link } }] });
  } else if (o.headerParams?.length) {
    components.push({ type: 'header', parameters: textParams(o.headerParams, o.named) });
  }

  if (o.bodyParams?.length) {
    components.push({ type: 'body', parameters: textParams(o.bodyParams, o.named) });
  }

  for (const b of o.buttonParams || []) {
    if (b.value === undefined || b.value === '') continue;
    components.push({
      type: 'button',
      sub_type: b.subType || 'url',
      index: String(b.index),
      parameters: [{ type: b.subType === 'quick_reply' ? 'payload' : 'text', [b.subType === 'quick_reply' ? 'payload' : 'text']: String(b.value) }],
    });
  }

  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: o.to,
    type: 'template',
    template: {
      name: o.template,
      language: { code: o.language || 'en_US' },
      ...(components.length ? { components } : {}),
    },
  };

  return call(`${base()}/${s.phoneNumberId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${s.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

/**
 * Send plain text. Only reaches people with an open 24h customer service
 * window (i.e. they messaged you in the last 24h). Not usable for cold promo.
 */
export async function sendText(to, body, previewUrl = true) {
  const s = cfg();
  return call(`${base()}/${s.phoneNumberId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${s.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { preview_url: previewUrl, body },
    }),
  });
}

export async function getPhoneNumberHealth() {
  const s = cfg();
  const fields = 'display_phone_number,verified_name,quality_rating,messaging_limit_tier,throughput';
  const url = `${base()}/${s.phoneNumberId}?fields=${fields}&access_token=${encodeURIComponent(s.accessToken)}`;
  return call(url);
}

// ---- error classification ------------------------------------------------
// Decides what the sender loop should do with a given Graph API failure.

const NO_RETRY = new Set([
  131026, // message undeliverable / recipient not on WhatsApp
  131047, // re-engagement required (no template / window closed)
  131051, // unsupported message type
  132000, // template param count mismatch
  132001, // template does not exist in this language
  132005, // translated text too long
  132007, // template format character policy violated
  132012, // template parameter format mismatch
  132015, // template paused for quality
  132016, // template disabled
  132068, // flow is blocked
  133010, // phone number not registered
]);

const RATE_LIMIT = new Set([
  4, // application request limit reached
  80007, // rate limit issues
  130429, // cloud API message throughput reached
  131048, // spam rate limit hit
  131056, // pair rate limit hit (too many messages to same number)
  133016, // too many attempts / temporarily blocked
]);

// Hit the per-user marketing template limit — the user is fine, WhatsApp just
// decided they've had enough marketing today. Skip, do not count as a failure.
const MARKETING_LIMIT = new Set([131049]);

export function classifyError(err) {
  const code = Number(err.code);
  if (MARKETING_LIMIT.has(code)) return { kind: 'skip', reason: 'per-user marketing limit' };
  if (NO_RETRY.has(code)) return { kind: 'fail', retry: false };
  if (RATE_LIMIT.has(code)) return { kind: 'throttle', retry: true };
  if (code === 190 || code === 102) return { kind: 'auth', retry: false }; // token expired/invalid
  if (code === 131031 || code === 368) return { kind: 'account', retry: false }; // account locked / restricted
  if (err.status >= 500 || err.status === 429) return { kind: 'throttle', retry: true };
  return { kind: 'fail', retry: true };
}

export const ERROR_HINTS = {
  190: 'Access token expired or revoked. Generate a permanent System User token in Business Settings.',
  131026: 'This number is not on WhatsApp, or cannot receive your message. Mark it invalid.',
  131047: 'The 24h window is closed — you must use an approved template for this contact.',
  131049: 'WhatsApp is limiting marketing messages to this user today. Try them in a later campaign.',
  131048: 'Spam rate limit hit. Your number is being throttled — slow down and check message quality.',
  131031: 'Your WhatsApp Business Account has been restricted. Check Account Quality in Business Manager.',
  132015: 'This template is paused for low quality. Fix the copy and resubmit it.',
  132001: 'Template name/language pair does not exist. Check the language code (e.g. fr vs fr_FR).',
  133016: 'Number temporarily blocked from sending. Stop sending and let it cool down.',
};
