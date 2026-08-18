/* eslint-disable no-undef */
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let toastTimer;
function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `show${isError ? ' err' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = ''), isError ? 6000 : 2800);
}

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    ...opts,
    headers: opts.body instanceof FormData ? undefined : { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  if (res.status === 401) {
    location.replace('/login.html'); // session expired or password changed elsewhere
    throw new Error('Not signed in.');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body.error || `HTTP ${res.status}`) + (body.code ? ` (Meta error ${body.code})` : ''));
  return body;
}

/**
 * In-page confirmation. Browsers can suppress native confirm()/prompt() dialogs
 * entirely, which silently turns a Delete button into a no-op.
 */
function askConfirm(message, okLabel = 'Yes, delete') {
  return new Promise((resolve) => {
    const modal = $('#modal');
    $('#modalMsg').textContent = message;
    $('#modalOk').textContent = okLabel;
    modal.classList.remove('hidden');

    const done = (value) => {
      modal.classList.add('hidden');
      $('#modalOk').onclick = null;
      $('#modalCancel').onclick = null;
      modal.onclick = null;
      document.removeEventListener('keydown', onKey);
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') done(false);
      if (e.key === 'Enter') done(true);
    };
    $('#modalOk').onclick = () => done(true);
    $('#modalCancel').onclick = () => done(false);
    modal.onclick = (e) => { if (e.target === modal) done(false); };
    document.addEventListener('keydown', onKey);
    $('#modalOk').focus();
  });
}

function setStatus(el, state, text) {
  el.className = `status ${state}`; // ok | warn | bad | ''
  el.textContent = text;
  el.closest('.step').classList.toggle('done', state === 'ok');
}

// ------------------------------------------------------------------- tabs
$$('.tab').forEach((t) => t.addEventListener('click', () => {
  $$('.tab').forEach((x) => x.classList.remove('active'));
  $$('.panel').forEach((x) => x.classList.remove('active'));
  t.classList.add('active');
  $(`#tab-${t.dataset.tab}`).classList.add('active');
  if (t.dataset.tab === 'results') { loadCampaigns(); loadInbox(); }
  if (t.dataset.tab === 'send') {
    refreshAudience();
    if (!templates.length) loadTemplates().catch(() => {}); // no need to press a button first
  }
}));

// -------------------------------------------------------- setup checklist
async function loadStatus() {
  const s = await api('/setup-status');

  setStatus($('#st1'), s.credentials ? 'ok' : '', s.credentials ? 'IDs saved' : 'do this once');
  if (s.connected) {
    setStatus($('#st2'), 'ok', 'connected');
    $('#testResult').className = 'result ok';
    $('#testResult').innerHTML = `Connected to <b>${esc(s.number.display_phone_number)}</b> (${esc(s.number.verified_name || '')}) ·
      quality <b>${esc(s.number.quality_rating || '—')}</b> · limit ${esc((s.number.messaging_limit_tier || '—').replace('TIER_', ''))} contacts / 24h`;
  } else if (s.credentials) {
    setStatus($('#st2'), 'bad', 'not working');
    $('#testResult').className = 'result bad';
    $('#testResult').textContent = s.error || 'Could not reach Meta with these credentials.';
  } else {
    setStatus($('#st2'), '', 'waiting');
    $('#testResult').className = 'result';
    $('#testResult').textContent = '';
  }

  if (s.templates === null) setStatus($('#st3'), '', 'waiting');
  else if (s.templates.approved > 0) setStatus($('#st3'), 'ok', `${s.templates.approved} approved`);
  else setStatus($('#st3'), 'warn', 'none approved yet');

  setStatus($('#st4'), s.webhookSeen ? 'ok' : 'warn', s.webhookSeen ? 'receiving replies' : 'not connected');
  $('#webhookStatus').textContent = s.webhookSeen
    ? `Last event received ${new Date(s.webhookSeen).toLocaleString()}.`
    : 'No webhook traffic yet. You can still send — you just won\'t get delivery status or automatic opt-outs.';

  // header pills
  if (s.connected) {
    const q = (s.number.quality_rating || 'UNKNOWN').toUpperCase();
    $('#pillNumber').textContent = s.number.display_phone_number;
    $('#pillNumber').className = 'pill good';
    $('#pillQuality').textContent = `quality: ${q}`;
    $('#pillQuality').className = `pill ${q === 'GREEN' ? 'good' : q === 'YELLOW' ? 'warn' : q === 'RED' ? 'bad' : ''}`;
  } else {
    $('#pillNumber').textContent = 'not connected';
    $('#pillNumber').className = 'pill bad';
  }
  $('#pillToday').textContent = `sent today: ${s.last24h} · this hour: ${s.lastHour}`;
  return s;
}

async function loadSettings() {
  const s = await api('/settings');
  $('#setPhoneNumberId').value = s.phoneNumberId || '';
  $('#setWabaId').value = s.wabaId || '';
  $('#setCountryCode').value = s.defaultCountryCode || '';
  $('#setVerifyToken').value = s.verifyToken || '';
  $('#setOptOut').value = s.optOutKeywords || '';
  $('#verifyTokenShow').textContent = s.verifyToken || '—';
  $('#setAccessToken').placeholder = s.accessTokenSet ? `saved (${s.accessTokenTail}) — leave blank to keep it` : 'EAAG…';
}

$('#btnSaveSettings').addEventListener('click', async () => {
  const btn = $('#btnSaveSettings');
  btn.disabled = true;
  btn.textContent = 'testing…';
  try {
    await api('/settings', {
      method: 'POST',
      body: JSON.stringify({
        phoneNumberId: $('#setPhoneNumberId').value.trim(),
        wabaId: $('#setWabaId').value.trim(),
        accessToken: $('#setAccessToken').value.trim(),
        defaultCountryCode: $('#setCountryCode').value.trim() || '212',
      }),
    });
    $('#setAccessToken').value = '';
    await loadSettings();
    const s = await loadStatus();
    // Credentials just changed, so the template list is stale — refresh it now rather
    // than making the user press a button or reload the page.
    if (s.connected) await loadTemplates().catch(() => {});
    toast(s.connected ? 'Connected' : 'Saved, but the connection test failed', !s.connected);
  } catch (err) { toast(err.message, true); }
  btn.disabled = false;
  btn.textContent = 'Save & test connection';
});

$('#btnSaveWebhook').addEventListener('click', async () => {
  await api('/settings', {
    method: 'POST',
    body: JSON.stringify({ verifyToken: $('#setVerifyToken').value.trim(), optOutKeywords: $('#setOptOut').value.trim() }),
  });
  $('#verifyTokenShow').textContent = $('#setVerifyToken').value.trim() || '—';
  toast('Saved');
});

// --------------------------------------------------------------- contacts
let contactsCache = [];

async function loadContacts() {
  const params = new URLSearchParams({
    q: $('#searchContacts').value.trim(), tag: $('#filterTag').value, status: $('#filterStatus').value,
  });
  const data = await api(`/contacts?${params}`);
  contactsCache = data.items;
  $('#contactCount').textContent = `${data.total} shown · ${data.grandTotal} total · ${data.optOuts} opted out`;

  const tagSel = $('#filterTag');
  const current = tagSel.value;
  tagSel.innerHTML = '<option value="">all tags</option>' + data.tags.map((t) => `<option${t === current ? ' selected' : ''}>${esc(t)}</option>`).join('');
  renderTagChips(data.tags);
  queueMicrotask(syncPicked); // recount hidden ticks after the table re-renders

  $('#contactsTable').innerHTML = `
    <thead><tr><th></th><th>Number</th><th>Name</th><th>Tags</th><th>Status</th><th>Last contacted</th><th></th></tr></thead>
    <tbody>${data.items.map(rowHtml).join('') || '<tr><td colspan="7" class="muted">No contacts yet — import a file above.</td></tr>'}</tbody>`;
}

// Tags double as audience categories, so they get clickable chips rather than a
// multi-select nobody can operate without ctrl-clicking.
const chosenTags = new Set();
function renderTagChips(tags) {
  for (const t of [...chosenTags]) if (!tags.includes(t)) chosenTags.delete(t);
  $('#audTagChips').innerHTML = tags.length
    ? tags.map((t) => `<button type="button" class="chip${chosenTags.has(t) ? ' on' : ''}" data-tag="${esc(t)}">${esc(t)}</button>`).join('')
    : '<span class="muted small">No categories yet — tick some contacts on the Contacts tab and give them a category name.</span>';
}
$('#audTagChips').addEventListener('click', (e) => {
  const t = e.target.dataset?.tag;
  if (!t) return;
  if (chosenTags.has(t)) chosenTags.delete(t); else chosenTags.add(t);
  e.target.classList.toggle('on');
  refreshAudience();
});

// Contacts ticked on the Contacts tab, remembered across tab switches.
const pickedIds = new Set();

/** Ids ticked earlier that the current search/filter is hiding. */
function hiddenPicked() {
  const visible = new Set($$('.csel').map((b) => b.value));
  return [...pickedIds].filter((id) => !visible.has(id));
}

function syncPicked() {
  const hidden = hiddenPicked().length;
  // A selection that outlives the filter is useful, but it MUST be visible —
  // otherwise "delete 1 row" silently means "delete everything ticked earlier".
  $('#selCount').innerHTML = `${pickedIds.size} ticked`
    + (hidden ? ` <span class="s-failed">(${hidden} hidden by your filter)</span>` : '');
  $('#pickedCount').textContent = pickedIds.size;
}

$('#btnClearSel').addEventListener('click', () => {
  pickedIds.clear();
  $$('.csel').forEach((b) => (b.checked = false));
  $('#selectAll').checked = false;
  syncPicked();
  refreshAudience();
});

function rowHtml(c) {
  const status = c.optOut ? '<span class="s-skipped">opted out</span>'
    : c.invalid ? '<span class="s-failed">invalid</span>' : '<span class="s-sent">active</span>';
  return `<tr>
    <td><input type="checkbox" class="csel" value="${c.id}"${pickedIds.has(c.id) ? ' checked' : ''}></td>
    <td>+${esc(c.phone)}</td><td>${esc(c.name)}</td>
    <td>${(c.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</td>
    <td>${status}</td>
    <td class="muted small">${c.lastSentAt ? new Date(c.lastSentAt).toLocaleDateString() : '—'}</td>
    <td><button class="ghost small" data-toggle-optout="${c.id}" data-val="${c.optOut ? 0 : 1}">${c.optOut ? 'opt in' : 'opt out'}</button></td>
  </tr>`;
}

$('#searchContacts').addEventListener('input', debounce(loadContacts, 250));
$('#filterTag').addEventListener('change', loadContacts);
$('#filterStatus').addEventListener('change', loadContacts);
$('#selectAll').addEventListener('change', (e) => {
  $$('.csel').forEach((c) => {
    c.checked = e.target.checked;
    if (e.target.checked) pickedIds.add(c.value); else pickedIds.delete(c.value);
  });
  syncPicked();
  refreshAudience();
});

$('#contactsTable').addEventListener('change', (e) => {
  if (!e.target.classList.contains('csel')) return;
  if (e.target.checked) pickedIds.add(e.target.value); else pickedIds.delete(e.target.value);
  syncPicked();
  refreshAudience();
});

$('#contactsTable').addEventListener('click', async (e) => {
  const id = e.target.dataset?.toggleOptout;
  if (!id) return;
  await api(`/contacts/${id}`, { method: 'PATCH', body: JSON.stringify({ optOut: e.target.dataset.val === '1' }) });
  loadContacts();
});

$$('[data-bulk]').forEach((b) => b.addEventListener('click', async () => {
  const ids = [...pickedIds];
  if (!ids.length) return toast('Tick some contacts first', true);
  const action = b.dataset.bulk;
  let tag;
  if (action === 'tag' || action === 'untag') {
    tag = $('#bulkTag').value.trim();
    if (!tag) return toast('Type a category name first', true);
  }
  if (action === 'delete') {
    const hidden = hiddenPicked().length;
    const warning = hidden ? `\n\n${hidden} of them are NOT shown in the table right now — they were ticked before you searched or filtered.` : '';
    if (!await askConfirm(`Delete ${ids.length} contact(s)? This cannot be undone.${warning}`)) return;
  }
  await api('/contacts/bulk', { method: 'POST', body: JSON.stringify({ ids, action, tag }) });
  if (action === 'delete') { pickedIds.clear(); syncPicked(); }
  $('#selectAll').checked = false;
  toast(action === 'tag' ? `${ids.length} contact(s) put in “${tag}”` : 'Done');
  await loadContacts();
  refreshAudience();
}));

$('#btnQuickAdd').addEventListener('click', async () => {
  const numbers = $('#quickAdd').value.trim();
  if (!numbers) return;
  const r = await api('/contacts/quick-add', { method: 'POST', body: JSON.stringify({ numbers, tags: tagList($('#importTag').value) }) });
  $('#quickAddResult').textContent = `added ${r.added}, duplicates ${r.duplicate}${r.invalid.length ? `, rejected: ${r.invalid.join(', ')}` : ''}`;
  $('#quickAdd').value = '';
  loadContacts();
});

const tagList = (v) => v.split(',').map((s) => s.trim()).filter(Boolean);

let importRows = null;
let lastFile = null;

async function runPreview(remap = false) {
  const file = $('#fileInput').files[0] || lastFile;
  if (!file) return toast('Choose a file first', true);
  lastFile = file;
  const fd = new FormData();
  fd.append('file', file);
  if (remap) { fd.append('phoneCol', $('#phoneCol').value); fd.append('nameCol', $('#nameCol').value); }

  const res = await fetch('/api/contacts/preview', { method: 'POST', body: fd });
  const data = await res.json();
  if (!res.ok) return toast(data.error || 'Import failed', true);

  importRows = data.rows;
  $('#importPreview').classList.remove('hidden');
  // Carry over whatever was typed on the upload card, but let it be set here too.
  if (!$('#importTag2').value) $('#importTag2').value = $('#importTag').value;
  const c = data.counts;
  $('#importCounts').innerHTML = `
    <span class="stat"><b>${c.total}</b><small>rows in file</small></span>
    <span class="stat"><b class="s-sent">${c.valid}</b><small>usable numbers</small></span>
    <span class="stat"><b class="s-failed">${c.invalid}</b><small>unusable</small></span>
    <span class="stat"><b class="s-skipped">${c.duplicateInFile}</b><small>duplicates in file</small></span>
    <span class="stat"><b class="s-skipped">${c.alreadyExists}</b><small>already saved</small></span>`;

  const opts = (sel) => data.headers.map((h) => `<option${h === sel ? ' selected' : ''}>${esc(h)}</option>`).join('');
  $('#phoneCol').innerHTML = opts(data.phoneCol);
  $('#nameCol').innerHTML = `<option value="">— none —</option>${opts(data.nameCol)}`;

  const extra = Object.keys(data.sample[0]?.fields || {}).slice(0, 4);
  $('#previewTable').innerHTML = `
    <thead><tr><th>In your file</th><th>Will send to</th><th>Name</th>${extra.map((k) => `<th>${esc(k)}</th>`).join('')}<th>Note</th></tr></thead>
    <tbody>${data.sample.map((r) => `<tr>
      <td class="muted">${esc(r.raw)}</td>
      <td class="${r.valid ? 's-sent' : 's-failed'}">${r.valid ? `+${esc(r.phone)}` : '—'}</td>
      <td>${esc(r.name)}</td>
      ${extra.map((k) => `<td>${esc(r.fields[k])}</td>`).join('')}
      <td class="muted small">${r.valid ? (r.alreadyExists ? 'already saved (will update)' : r.duplicateInFile ? 'duplicate in file' : '') : esc(r.problem)}</td>
    </tr>`).join('')}</tbody>`;
}

$('#btnPreview').addEventListener('click', () => runPreview(false).catch((e) => toast(e.message, true)));
$('#btnRemap').addEventListener('click', () => runPreview(true).catch((e) => toast(e.message, true)));
$('#btnCancelImport').addEventListener('click', () => { $('#importPreview').classList.add('hidden'); importRows = null; });

$('#btnConfirmImport').addEventListener('click', async () => {
  if (!importRows) return;
  const tags = tagList($('#importTag2').value || $('#importTag').value);
  if (!tags.length && !await askConfirm('Import without a category? You will not be able to target this batch separately later.', 'Import anyway')) return;

  const r = await api('/contacts/import', { method: 'POST', body: JSON.stringify({ rows: importRows, tags }) });
  toast(`Imported ${r.added} new, updated ${r.updated}${tags.length ? ` into “${tags.join(', ')}”` : ''}`);
  $('#importPreview').classList.add('hidden');
  $('#importTag2').value = '';
  importRows = null;
  await loadContacts();
  refreshAudience();
});

// ------------------------------------------------------------------- send
let templates = [];

$('#btnLoadTemplates').addEventListener('click', loadTemplates);
async function loadTemplates() {
  try {
    templates = await api('/templates');
    const ok = templates.filter((t) => t.status === 'APPROVED');
    $('#templateSelect').innerHTML = '<option value="">— pick your message —</option>' + templates.map((t, i) =>
      `<option value="${i}"${t.status !== 'APPROVED' ? ' disabled' : ''}>${esc(t.name)} · ${t.language}${t.status !== 'APPROVED' ? ` (${t.status})` : ''}</option>`).join('');
    $('#templateStatus').textContent = templates.length
      ? `${ok.length} approved of ${templates.length}`
      : 'Connected, but this business account has no templates at all — create one in WhatsApp Manager.';
    $('#templateList').innerHTML = templates.length ? `<div class="tablewrap"><table>
      <thead><tr><th>Template</th><th>Language</th><th>Type</th><th>Status</th></tr></thead>
      <tbody>${templates.map((t) => `<tr><td>${esc(t.name)}</td><td>${esc(t.language)}</td><td class="muted">${esc(t.category)}</td>
        <td class="${t.status === 'APPROVED' ? 's-sent' : t.status === 'REJECTED' ? 's-failed' : 's-skipped'}">${esc(t.status)}</td></tr>`).join('')}</tbody>
      </table></div>` : '<p class="muted small">No templates yet — create one in WhatsApp Manager using the steps above.</p>';
    await loadStatus();
    if (ok.length) toast(`${ok.length} template(s) ready to use`);
  } catch (err) {
    // The reason a template list comes back empty is almost always one of three things.
    const diag = /error 100|Unsupported get|does not exist/i.test(err.message)
      ? 'That WhatsApp Business Account ID looks wrong — it is not the app ID and not the phone number ID. Copy it from WhatsApp → API Setup.'
      : /error 200|error 190|permission/i.test(err.message)
        ? 'Your token cannot read templates. Regenerate it with whatsapp_business_management ticked, and assign the WhatsApp account asset to the system user.'
        : /Business Account ID configured/i.test(err.message)
          ? 'Fill in the Business account ID in step 2.'
          : '';
    $('#templateStatus').innerHTML = `<span class="s-failed">${esc(err.message)}</span>${diag ? `<br>${esc(diag)}` : ''}`;
    $('#templateSelect').innerHTML = `<option value="">— could not load templates, see Start here —</option>`;
    toast(err.message, true);
  }
}

$('#templateSelect').addEventListener('change', () => {
  const t = templates[$('#templateSelect').value];
  if (!t) return;
  $('#templateBody').textContent = t.components.find((c) => c.type === 'BODY')?.text || '(no body)';

  const s = t.shape;
  let html = '';
  if (s.headerType && s.headerType !== 'TEXT') {
    html += `<div class="varrow"><span>${s.headerType.toLowerCase()}</span><input id="hdrMedia" placeholder="public https:// link to the ${s.headerType.toLowerCase()}"></div>`;
  }
  // Guess a sensible default: a named placeholder usually matches a column name.
  const guess = (token, i) => {
    if (/^\d+$/.test(token)) return i === 0 ? '{{name|client}}' : '';
    return /nom|name|client|prenom/i.test(token) ? '{{name|client}}' : `{{${token}}}`;
  };
  s.headerTokens.forEach((tok, i) => {
    html += `<div class="varrow"><span>title {{${esc(tok)}}}</span><input class="hdrvar" data-name="${esc(tok)}" value="${esc(guess(tok, i))}"></div>`;
  });
  s.bodyTokens.forEach((tok, i) => {
    html += `<div class="varrow"><span>{{${esc(tok)}}} =</span><input class="bodyvar" data-name="${esc(tok)}" value="${esc(guess(tok, i))}"></div>`;
  });
  for (const b of s.buttons) {
    if (b.urlVars) html += `<div class="varrow"><span>button link</span><input class="btnvar" data-index="${b.index}" placeholder="e.g. {{phone}}"></div>`;
  }
  $('#templateVars').innerHTML = (html || '<p class="muted small">This template has no variables — everyone gets the same text.</p>')
    + (s.bodyTokens.length
      ? `<p class="muted small">Left side = the placeholder <b>inside your Meta template</b> (${s.named ? 'named' : 'positional'} format).
         Right side = what to put there, taken from <b>your file</b>: a column name like <code>{{city}}</code>, or
         <code>{{name|client}}</code> to fall back to “client” when the name is missing.</p>`
      : '');
  refreshAudience();
});

$('#btnAddVariant').addEventListener('click', () => addVariant());
function addVariant(value = '') {
  const div = document.createElement('div');
  div.className = 'varrow';
  div.innerHTML = `<textarea rows="3" class="variant" placeholder="Bonjour {{name|cher client}}, …">${esc(value)}</textarea><button class="ghost danger">×</button>`;
  div.querySelector('button').addEventListener('click', () => div.remove());
  $('#variants').appendChild(div);
}
addVariant();

// ---- pacing presets
const PRESETS = {
  safe: { minDelaySec: 45, maxDelaySec: 120, batchSize: 25, batchPauseMin: 20, dailyCap: 200, hourlyCap: 40, windowStart: 9, windowEnd: 20, respectWindow: true },
  normal: { minDelaySec: 25, maxDelaySec: 70, batchSize: 40, batchPauseMin: 12, dailyCap: 900, hourlyCap: 120, windowStart: 9, windowEnd: 20, respectWindow: true },
  fast: { minDelaySec: 8, maxDelaySec: 20, batchSize: 100, batchPauseMin: 5, dailyCap: 5000, hourlyCap: 400, windowStart: 8, windowEnd: 21, respectWindow: true },
};

function applyPreset(name) {
  const p = PRESETS[name];
  for (const [k, v] of Object.entries(p)) {
    const el = $(`#${k}`);
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = v; else el.value = v;
  }
  $$('.preset').forEach((el) => el.classList.toggle('selected', el.dataset.preset === name));
  refreshAudience();
}
$$('input[name=preset]').forEach((r) => r.addEventListener('change', () => applyPreset(r.value)));

function throttleNow() {
  return {
    minDelaySec: +$('#minDelaySec').value, maxDelaySec: +$('#maxDelaySec').value,
    batchSize: +$('#batchSize').value, batchPauseMin: +$('#batchPauseMin').value,
    dailyCap: +$('#dailyCap').value, hourlyCap: +$('#hourlyCap').value,
    respectWindow: $('#respectWindow').checked, windowStart: +$('#windowStart').value, windowEnd: +$('#windowEnd').value,
  };
}

function campaignPayload() {
  const audience = {
    tags: [...chosenTags],
    ids: $('#audUsePicked').checked ? [...pickedIds] : [],
    excludeSentWithinDays: Number($('#audCooldown').value) || 0,
    limit: Number($('#audLimit').value) || 0,
    shuffle: true,
  };
  const useText = $('#useText').checked;
  const p = { name: $('#campName').value.trim(), mode: useText ? 'text' : 'template', audience, throttle: throttleNow(), dryRun: $('#dryRun').checked };

  if (useText) {
    p.textVariants = $$('.variant').map((t) => t.value.trim()).filter(Boolean);
  } else {
    const t = templates[$('#templateSelect').value];
    if (t) {
      p.template = {
        name: t.name, language: t.language, named: t.shape.named,
        bodyMap: $$('.bodyvar').map((i) => ({ name: i.dataset.name, pattern: i.value })),
        headerMap: $$('.hdrvar').map((i) => ({ name: i.dataset.name, pattern: i.value })),
        headerMedia: $('#hdrMedia')?.value ? { type: t.shape.headerType.toLowerCase(), link: $('#hdrMedia').value.trim() } : null,
        buttonMap: $$('.btnvar').filter((i) => i.value).map((i) => ({ index: +i.dataset.index, subType: 'url', value: i.value })),
      };
    }
  }
  return p;
}

async function refreshAudience() {
  const t = throttleNow();
  const gap = Math.round((t.minDelaySec + t.maxDelaySec) / 2);
  $('#paceSummary').textContent =
    `About one message every ${gap}s, ${t.batchSize} at a time then a ${t.batchPauseMin} min break. `
    + `Never more than ${t.dailyCap}/day or ${t.hourlyCap}/hour`
    + (t.respectWindow ? `, and only between ${t.windowStart}h and ${t.windowEnd}h.` : ', at any hour.');

  try {
    const { count, total, excluded, sample } = await api('/campaigns/audience-count', { method: 'POST', body: JSON.stringify({ audience: campaignPayload().audience }) });
    $('#audienceCount').textContent = count;

    // Say out loud why anyone was left out — otherwise a 0 here looks like a bug.
    const why = [];
    if (excluded.notInTag) why.push(`${excluded.notInTag} not in the selected categories`);
    if (excluded.notPicked) why.push(`${excluded.notPicked} not ticked`);
    if (excluded.recentlyContacted) why.push(`<b class="s-skipped">${excluded.recentlyContacted} contacted in the last ${$('#audCooldown').value} days</b>`);
    if (excluded.optOut) why.push(`${excluded.optOut} opted out`);
    if (excluded.invalid) why.push(`${excluded.invalid} invalid number`);
    if (excluded.overLimit) why.push(`${excluded.overLimit} over your limit`);
    $('#audienceWhy').innerHTML = why.length
      ? `Out of ${total} contacts, left out: ${why.join(' · ')}.`
      : `All ${total} of your contacts are included.`;
    $('#audienceSample').innerHTML = sample.length
      ? `<span class="muted small">Going to:</span> ${sample.map((c) => `<span class="tag">${esc(c.name || `+${c.phone}`)}</span>`).join('')}${count > sample.length ? `<span class="muted small"> +${count - sample.length} more</span>` : ''}`
      : '';

    const batches = t.batchSize > 0 ? Math.floor(count / t.batchSize) : 0;
    const minutes = (count * gap) / 60 + batches * t.batchPauseMin;
    const hoursPerDay = t.respectWindow ? ((t.windowEnd - t.windowStart + 24) % 24 || 24) : 24;
    const perDay = Math.min(t.dailyCap, hoursPerDay * t.hourlyCap);
    const days = Math.ceil(count / Math.max(1, perDay));
    $('#paceSummary').textContent += count
      ? `  →  ${count} people takes about ${minutes < 90 ? `${Math.round(minutes)} minutes` : `${(minutes / 60).toFixed(1)} hours`}${days > 1 ? `, spread over ~${days} days` : ''}.`
      : '';
  } catch { /* best effort */ }
}
['audUsePicked', 'audCooldown', 'audLimit', 'minDelaySec', 'maxDelaySec', 'batchSize', 'batchPauseMin', 'dailyCap', 'hourlyCap', 'respectWindow', 'windowStart', 'windowEnd']
  .forEach((id) => $(`#${id}`)?.addEventListener('change', refreshAudience));

$('#btnPreviewMsg').addEventListener('click', async () => {
  try {
    const r = await api('/preview', { method: 'POST', body: JSON.stringify({ ...campaignPayload(), contactId: contactsCache[0]?.id }) });
    $('#msgPreview').textContent = `${r.contact.name || r.contact.phone} would get:  ${r.preview}`;
  } catch (err) { toast(err.message, true); }
});

$('#btnCreateCampaign').addEventListener('click', async () => {
  try {
    const camp = await api('/campaigns', { method: 'POST', body: JSON.stringify(campaignPayload()) });
    toast('Campaign created');
    $$('.tab').find((t) => t.dataset.tab === 'results').click();
  } catch (err) {
    $('#createResult').textContent = err.message;
    toast(err.message, true);
  }
});

// ---------------------------------------------------------------- results
let pollTimer = null;

async function loadCampaigns() {
  const list = await api('/campaigns');
  $('#campaignList').innerHTML = list.map(campHtml).join('') || '<p class="muted">Nothing yet. Build one on the Send tab.</p>';
  clearTimeout(pollTimer);
  if (list.some((c) => c.status === 'running')) {
    if ($('#tab-results').classList.contains('active')) pollTimer = setTimeout(loadCampaigns, 4000);
    loadStatusThrottled();
  }
}

let lastStatusAt = 0;
function loadStatusThrottled() {
  if (Date.now() - lastStatusAt > 60000) { lastStatusAt = Date.now(); loadStatus().catch(() => {}); }
}

function campHtml(c) {
  const s = c.stats || {};
  const pct = (n) => `${((n / Math.max(1, s.total)) * 100).toFixed(1)}%`;
  const running = c.status === 'running';
  return `<div class="camp" data-id="${c.id}" data-name="${esc(c.name)}">
    <div class="top">
      <div>
        <div class="name">${esc(c.name)} ${c.dryRun ? '<span class="tag">test run</span>' : ''}</div>
        <div class="muted small">${c.mode === 'text' ? 'free text' : `template “${esc(c.template?.name || '')}”`} · ${new Date(c.createdAt).toLocaleString()}</div>
      </div>
      <div class="row" style="margin:0">
        <span class="s-${c.status}">${c.status}</span>
        ${running ? '<button data-act="pause">Pause</button>' : `<button class="primary" data-act="start">${s.sent ? 'Resume' : 'Start sending'}</button>`}
        ${['running', 'paused'].includes(c.status) ? '<button class="ghost danger" data-act="stop">Stop</button>' : ''}
        ${s.failed ? '<button class="ghost" data-act="retry">Retry failed</button>' : ''}
        <button class="ghost" data-act="open">Details</button>
        <button class="ghost danger" data-act="delete">🗑</button>
      </div>
    </div>
    <div class="bar"><i class="ok" style="width:${pct(s.sent)}"></i><i class="err" style="width:${pct(s.failed)}"></i><i class="skip" style="width:${pct(s.skipped)}"></i></div>
    <div class="muted small">${s.sent || 0} sent · ${s.delivered || 0} delivered · ${s.read || 0} read · ${s.failed || 0} failed · ${s.skipped || 0} skipped · ${s.pending || 0} left — of ${s.total || 0}</div>
    ${c.runtime?.note ? `<div class="note">▶ ${esc(c.runtime.note)}</div>` : ''}
    ${c.lastError ? `<div class="note warn">⚠ ${esc(c.lastError)}</div>` : ''}
  </div>`;
}

$('#campaignList').addEventListener('click', async (e) => {
  const act = e.target.dataset?.act;
  if (!act) return;
  const id = e.target.closest('.camp').dataset.id;
  try {
    if (act === 'open') return openDetail(id);
    if (act === 'delete') {
      const name = e.target.closest('.camp').dataset.name || 'this campaign';
      if (!await askConfirm(`Delete “${name}” and its send log? Your contacts are not affected.`)) return;
      await api(`/campaigns/${id}`, { method: 'DELETE' });
    } else if (act === 'retry') {
      const r = await api(`/campaigns/${id}/retry-failed`, { method: 'POST' });
      toast(`${r.requeued} recipients requeued`);
    } else {
      await api(`/campaigns/${id}/${act}`, { method: 'POST' });
      toast(act === 'start' ? 'Sending started' : `Campaign ${act}d`);
    }
    loadCampaigns();
  } catch (err) { toast(err.message, true); }
});

$('#btnRefreshCampaigns').addEventListener('click', loadCampaigns);

let detailId = null;
async function openDetail(id) {
  detailId = id;
  const filter = $('#detailFilter').value;
  const c = await api(`/campaigns/${id}${filter ? `?status=${filter}` : ''}`);
  $('#campaignDetail').classList.remove('hidden');
  $('#detailTitle').textContent = `${c.name} — ${c.recipientTotal} rows`;
  $('#detailTable').innerHTML = `
    <thead><tr><th>Number</th><th>Name</th><th>Status</th><th>Delivery</th><th>When</th><th>Message / problem</th></tr></thead>
    <tbody>${c.recipients.map((r) => `<tr>
      <td>+${esc(r.phone)}</td><td>${esc(r.name)}</td>
      <td class="s-${r.status}">${r.status}</td><td class="muted">${esc(r.delivery || '—')}</td>
      <td class="muted small">${r.at ? new Date(r.at).toLocaleTimeString() : '—'}</td>
      <td class="wrap muted small">${esc(r.error || r.preview || '')}${r.hint ? `<br><b>${esc(r.hint)}</b>` : ''}</td>
    </tr>`).join('')}</tbody>`;
  $('#campaignDetail').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
$('#detailFilter').addEventListener('change', () => detailId && openDetail(detailId));
$('#btnCloseDetail').addEventListener('click', () => $('#campaignDetail').classList.add('hidden'));
$('#btnExport').addEventListener('click', () => detailId && window.open(`/api/campaigns/${detailId}/export`));

async function loadInbox() {
  const rows = await api('/inbox');
  $('#inboxTable').innerHTML = `
    <thead><tr><th>From</th><th>Message</th><th>When</th><th></th></tr></thead>
    <tbody>${rows.map((r) => `<tr>
      <td>+${esc(r.from)}</td><td class="wrap">${esc(r.text)}</td>
      <td class="muted small">${new Date(r.at).toLocaleString()}</td>
      <td>${r.optOut ? '<span class="s-skipped">unsubscribed</span>' : ''}</td>
    </tr>`).join('') || '<tr><td colspan="4" class="muted">Nothing yet — connect the webhook in step 4.</td></tr>'}</tbody>`;
}
$('#btnRefreshInbox').addEventListener('click', loadInbox);

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

$('#btnLogout').addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  location.replace('/login.html');
});

// ------------------------------------------------------------------- boot
applyPreset('safe');
loadSettings().then(async () => {
  const s = await loadStatus();
  if (s.connected && s.wabaId) loadTemplates();
});
loadContacts().then(refreshAudience);
