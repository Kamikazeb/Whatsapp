/* eslint-disable no-undef */
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const initials = (name, phone) => (name || '').trim()
  ? name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase()
  : String(phone || '').slice(-2);

function timeAgo(ms) {
  if (!ms) return '';
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 604800) return `${Math.floor(s / 86400)}d`;
  return new Date(ms).toLocaleDateString();
}

let toastTimer;
function toast(msg, kind = 'ok') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = ''), kind === 'err' ? 6000 : 3000);
}

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    ...opts,
    headers: opts.body instanceof FormData ? undefined : { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  if (res.status === 401) {
    location.replace('/login.html');
    throw new Error('Not signed in.');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body.error || `HTTP ${res.status}`) + (body.code ? ` (Meta error ${body.code})` : ''));
  return body;
}

/** In-page confirmation — native confirm()/prompt() are blocked in some browsers. */
function askConfirm(message, okLabel = 'Yes, delete', title = 'Are you sure?') {
  return new Promise((resolve) => {
    const modal = $('#modal');
    $('#modalTitle').textContent = title;
    $('#modalMsg').textContent = message;
    $('#modalOk').textContent = okLabel;
    modal.classList.remove('hidden');

    const done = (v) => {
      modal.classList.add('hidden');
      $('#modalOk').onclick = null;
      $('#modalCancel').onclick = null;
      modal.onclick = null;
      document.removeEventListener('keydown', onKey);
      resolve(v);
    };
    const onKey = (e) => { if (e.key === 'Escape') done(false); if (e.key === 'Enter') done(true); };
    $('#modalOk').onclick = () => done(true);
    $('#modalCancel').onclick = () => done(false);
    modal.onclick = (e) => { if (e.target === modal) done(false); };
    document.addEventListener('keydown', onKey);
    $('#modalOk').focus();
  });
}

// ============================== navigation ==============================

const PAGES = {
  dashboard: ['Dashboard', 'How your messaging is performing'],
  conversations: ['Conversations', 'Reply to clients within 24 hours of their message'],
  send: ['New campaign', 'Build and launch a send'],
  campaigns: ['Campaigns', 'Start, pause and monitor your sends'],
  contacts: ['Contacts', 'Your client list and categories'],
  setup: ['Setup', 'Connect Meta and your message templates'],
};

let currentPage = 'dashboard';

function goto(page) {
  currentPage = page;
  $$('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.page === page));
  $$('.page').forEach((p) => p.classList.remove('active'));
  $(`#page-${page}`).classList.add('active');
  const [title, sub] = PAGES[page] || ['', ''];
  $('#pageTitle').textContent = title;
  $('#pageSub').textContent = sub;
  $('#sidebar').classList.remove('open');
  refreshPage();
}

$$('.nav-item').forEach((n) => n.addEventListener('click', () => goto(n.dataset.page)));
$$('[data-goto]').forEach((b) => b.addEventListener('click', () => goto(b.dataset.goto)));
$('#menuToggle').addEventListener('click', () => $('#sidebar').classList.toggle('open'));
$('#btnRefresh').addEventListener('click', () => { refreshPage(true); loadBadges(); });

function refreshPage(force = false) {
  if (currentPage === 'dashboard') loadDashboard();
  if (currentPage === 'conversations') loadConversations();
  if (currentPage === 'campaigns') loadCampaigns();
  if (currentPage === 'contacts') loadContacts();
  if (currentPage === 'send') { refreshAudience(); if (force || !templates.length) loadTemplates().catch(() => {}); }
  if (currentPage === 'setup') loadStatus();
}

// ============================== dashboard ==============================

async function loadDashboard() {
  let o;
  try {
    o = await api('/overview');
  } catch (err) {
    $('#dashAlerts').innerHTML = alertHtml('destructive', 'Could not load statistics', esc(err.message));
    return;
  }

  if (o.needsMigration) {
    $('#dashAlerts').innerHTML = alertHtml('warning', 'One database update left',
      `Run <code>${esc(o.migrationFile)}</code> in Supabase → SQL Editor to switch on Conversations and reply tracking. `
      + 'Everything else works meanwhile.');
    return;
  }

  // Header pills + brand line
  if (o.number) {
    const q = (o.number.quality || 'UNKNOWN').toUpperCase();
    $('#brandNumber').textContent = o.number.display || 'connected';
    const badge = q === 'GREEN' ? 'success' : q === 'YELLOW' ? 'warning' : q === 'RED' ? 'destructive' : 'outline';
    $('#pillQuality').className = `badge badge-${badge}`;
    $('#pillQuality').textContent = `quality ${q.toLowerCase()}`;
  } else {
    $('#brandNumber').textContent = 'not connected';
    $('#pillQuality').className = 'badge badge-destructive';
    $('#pillQuality').textContent = 'not connected';
  }
  $('#pillToday').textContent = `${o.sending.last24h} sent today`;

  // Alerts worth acting on
  const alerts = [];
  if (!o.number) {
    alerts.push(alertHtml('destructive', 'Not connected to Meta', 'Finish step 2 on the Setup page before sending.'));
  } else if ((o.number.quality || '').toUpperCase() === 'RED') {
    alerts.push(alertHtml('destructive', 'Your number quality is RED', 'Stop sending for a few days. Another red period and Meta cuts your limit.'));
  } else if ((o.number.quality || '').toUpperCase() === 'YELLOW') {
    alerts.push(alertHtml('warning', 'Your number quality is YELLOW', 'People are blocking or reporting you. Slow down and tighten your audience.'));
  }
  if (o.replies.unread) {
    alerts.push(alertHtml('info', `${o.replies.unread} unread ${o.replies.unread === 1 ? 'reply' : 'replies'}`, 'Clients are waiting. The 24-hour reply window closes fast.'));
  }
  if (o.contacts.optOuts > 0 && o.contacts.total > 0) {
    const rate = (o.contacts.optOuts / o.contacts.total) * 100;
    if (rate >= 3) alerts.push(alertHtml('warning', `${rate.toFixed(1)}% of your list has unsubscribed`, 'Above about 3% suggests the offer or the frequency is wrong.'));
  }
  $('#dashAlerts').innerHTML = alerts.join('');

  // Stat cards
  $('#statContacts').textContent = o.contacts.reachable.toLocaleString();
  $('#statContactsFoot').innerHTML = `${o.contacts.total.toLocaleString()} total · ${o.contacts.optOuts} unsubscribed · ${o.contacts.invalid} invalid`;

  $('#statSent24').textContent = o.sending.last24h.toLocaleString();
  $('#statSentFoot').innerHTML = `${o.sending.last7d.toLocaleString()} in 7 days`
    + (o.sending.failed7d ? ` · <span class="down">${o.sending.failed7d} failed</span>` : '');

  const rate = o.funnel.sent ? (o.funnel.delivered / o.funnel.sent) * 100 : 0;
  $('#statDelivery').textContent = o.funnel.sent ? `${rate.toFixed(0)}%` : '—';
  $('#statDeliveryFoot').innerHTML = o.funnel.sent
    ? `${o.funnel.delivered.toLocaleString()} of ${o.funnel.sent.toLocaleString()} delivered · ${o.funnel.read.toLocaleString()} read`
    : 'No messages sent yet';

  $('#statReplies').textContent = o.replies.last7d.toLocaleString();
  $('#statRepliesFoot').innerHTML = o.replies.unread
    ? `<span class="up">${o.replies.unread} unread</span>`
    : 'All caught up';

  // 14-day chart
  const max = Math.max(1, ...o.daily.map((d) => d.count));
  $('#chartDaily').innerHTML = o.daily.map((d, i) => {
    const h = Math.max(2, (d.count / max) * 100);
    const today = i === o.daily.length - 1;
    return `<div class="bar${today ? ' today' : ''}" style="height:${h}%" title="${d.date}: ${d.count} sent"></div>`;
  }).join('');
  $('#chartDailyX').innerHTML = o.daily.map((d, i) => {
    const show = i % 3 === 0 || i === o.daily.length - 1;
    return `<span>${show ? d.date.slice(8) + '/' + d.date.slice(5, 7) : ''}</span>`;
  }).join('');

  // Funnel
  const f = o.funnel;
  const base = Math.max(1, f.queued);
  const rows = [
    ['Queued', f.queued, false],
    ['Sent', f.sent, false],
    ['Delivered', f.delivered, true],
    ['Read', f.read, true],
    ['Failed', f.failed, false],
    ['Skipped', f.skipped, false],
  ];
  $('#funnel').innerHTML = rows.map(([name, n, alt]) => `
    <div class="funnel-row">
      <div class="fname">${name}</div>
      <div class="fbar"><i class="${alt ? 'alt' : ''}" style="width:${(n / base) * 100}%"></i></div>
      <div class="fval">${n.toLocaleString()}<small>${((n / base) * 100).toFixed(0)}%</small></div>
    </div>`).join('');

  // Recent campaigns
  $('#dashCampaigns').innerHTML = o.recentCampaigns.length
    ? o.recentCampaigns.map(campaignHtml).join('')
    : '<p class="muted small">No campaigns yet.</p>';
}

function alertHtml(kind, title, body) {
  const icon = kind === 'info'
    ? '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>'
    : '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4M12 17h.01"/>';
  return `<div class="alert alert-${kind}">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${icon}</svg>
    <div><div class="alert-title">${title}</div>${body}</div>
  </div>`;
}

// ============================ conversations ============================

let convos = [];
let openPhone = null;

async function loadConversations() {
  try {
    convos = await api('/conversations');
  } catch (err) {
    return toast(err.message, 'err');
  }
  renderConvoList();
  if (openPhone) openConversation(openPhone, true);
}

function renderConvoList() {
  const q = $('#convoSearch').value.trim().toLowerCase();
  const list = q
    ? convos.filter((c) => c.phone.includes(q) || (c.name || '').toLowerCase().includes(q))
    : convos;

  $('#convoItems').innerHTML = list.length ? list.map((c) => `
    <div class="convo-item${c.phone === openPhone ? ' active' : ''}" data-phone="${esc(c.phone)}">
      <div class="avatar">${esc(initials(c.name, c.phone))}</div>
      <div class="body">
        <div class="top">
          <span class="who">${esc(c.name || `+${c.phone}`)}</span>
          <span class="when">${timeAgo(c.lastAt)}</span>
        </div>
        <div class="snippet">${c.lastDirection === 'out' ? 'You: ' : ''}${esc(c.lastText || '')}</div>
        <div class="row" style="gap:5px;margin-top:5px">
          ${c.unread ? `<span class="unread">${c.unread}</span>` : ''}
          ${c.windowOpen ? '<span class="badge badge-success" style="font-size:10px;padding:0 6px">can reply</span>' : '<span class="badge badge-outline" style="font-size:10px;padding:0 6px">window closed</span>'}
          ${c.optOut ? '<span class="badge badge-destructive" style="font-size:10px;padding:0 6px">unsubscribed</span>' : ''}
        </div>
      </div>
    </div>`).join('')
    : '<div class="table-empty">No conversations yet.<br><span class="small">They appear when a client replies to you.</span></div>';
}

$('#convoSearch').addEventListener('input', renderConvoList);
$('#convoItems').addEventListener('click', (e) => {
  const item = e.target.closest('.convo-item');
  if (item) openConversation(item.dataset.phone);
});

async function openConversation(phone, keepScroll = false) {
  openPhone = phone;
  renderConvoList();
  let t;
  try {
    t = await api(`/conversations/${phone}`);
  } catch (err) {
    return toast(err.message, 'err');
  }

  $('#convoEmpty').classList.add('hidden');
  $('#convoThread').classList.remove('hidden');
  $('#convoAvatar').textContent = initials(t.contact?.name, phone);
  $('#convoWho').textContent = t.contact?.name || `+${phone}`;
  $('#convoMeta').innerHTML = `+${esc(phone)}`
    + (t.contact?.tags?.length ? ` · ${t.contact.tags.map((x) => `<span class="badge badge-secondary" style="font-size:10px">${esc(x)}</span>`).join(' ')}` : '')
    + (t.contact?.optOut ? ' · <span class="badge badge-destructive" style="font-size:10px">unsubscribed</span>' : '');
  $('#btnConvoOptOut').textContent = t.contact?.optOut ? 'Re-subscribe' : 'Unsubscribe';
  $('#btnConvoOptOut').dataset.optout = t.contact?.optOut ? '0' : '1';
  $('#btnConvoOptOut').dataset.id = t.contact?.id || '';

  const body = $('#convoBody');
  const wasAtBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 80;
  body.innerHTML = t.messages.map((m) => `
    <div class="bubble ${m.direction === 'out' ? 'out' : 'in'}">${esc(m.text)}
      <span class="time">${new Date(m.at).toLocaleString()}${m.direction === 'out' && m.status ? ` · ${esc(m.status)}` : ''}</span>
    </div>`).join('') || '<div class="convo-empty">No messages in this thread.</div>';
  if (!keepScroll || wasAtBottom) body.scrollTop = body.scrollHeight;

  const note = $('#windowNote');
  if (t.windowOpen) {
    const left = Math.max(0, t.windowClosesAt - Date.now());
    const h = Math.floor(left / 3600000);
    const m = Math.floor((left % 3600000) / 60000);
    note.className = 'window-note open';
    note.innerHTML = `<span class="dot"></span> You can send free text for another ${h}h ${m}m.`;
    $('#replyText').disabled = false;
    $('#btnSendReply').disabled = false;
    $('#replyText').placeholder = 'Type a reply…';
  } else {
    note.className = 'window-note closed';
    note.innerHTML = '<span class="dot"></span> The 24-hour window is closed. Only an approved template can reach this person now.';
    $('#replyText').disabled = true;
    $('#btnSendReply').disabled = true;
    $('#replyText').placeholder = 'Window closed — send a template campaign instead';
  }

  api(`/conversations/${phone}/read`, { method: 'POST' }).then(loadBadges).catch(() => {});
}

async function sendReply() {
  const text = $('#replyText').value.trim();
  if (!text || !openPhone) return;
  $('#btnSendReply').disabled = true;
  try {
    await api(`/conversations/${openPhone}/reply`, { method: 'POST', body: JSON.stringify({ text }) });
    $('#replyText').value = '';
    await openConversation(openPhone);
    await loadConversations();
    toast('Reply sent');
  } catch (err) {
    toast(err.message, 'err');
  }
  $('#btnSendReply').disabled = false;
}

$('#btnSendReply').addEventListener('click', sendReply);
$('#replyText').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendReply(); }
});
$('#btnConvoOptOut').addEventListener('click', async (e) => {
  const id = e.target.dataset.id;
  if (!id) return toast('This number is not in your contacts.', 'err');
  await api(`/contacts/${id}`, { method: 'PATCH', body: JSON.stringify({ optOut: e.target.dataset.optout === '1' }) });
  openConversation(openPhone);
  loadConversations();
});

// ============================== setup page ==============================

function setStatus(el, kind, text) {
  el.className = `badge badge-${kind}`;
  el.textContent = text;
  el.closest('.step').classList.toggle('done', kind === 'success');
}

async function loadStatus() {
  const s = await api('/setup-status');

  setStatus($('#st1'), s.credentials ? 'success' : 'outline', s.credentials ? 'IDs saved' : 'do this once');
  if (s.connected) {
    setStatus($('#st2'), 'success', 'connected');
    $('#testResult').className = 'result ok';
    $('#testResult').innerHTML = `Connected to <b>${esc(s.number.display_phone_number)}</b> (${esc(s.number.verified_name || '')}) ·
      quality <b>${esc(s.number.quality_rating || '—')}</b> · limit ${esc((s.number.messaging_limit_tier || '—').replace('TIER_', ''))} contacts / 24h`;
  } else if (s.credentials) {
    setStatus($('#st2'), 'destructive', 'not working');
    $('#testResult').className = 'result bad';
    $('#testResult').textContent = s.error || 'Could not reach Meta with these credentials.';
  } else {
    setStatus($('#st2'), 'outline', 'waiting');
    $('#testResult').textContent = '';
  }

  if (s.templates === null) setStatus($('#st3'), 'outline', 'waiting');
  else if (s.templates.approved > 0) setStatus($('#st3'), 'success', `${s.templates.approved} approved`);
  else setStatus($('#st3'), 'warning', 'none approved yet');

  setStatus($('#st4'), s.webhookSeen ? 'success' : 'warning', s.webhookSeen ? 'receiving replies' : 'not connected');
  $('#webhookStatus').textContent = s.webhookSeen
    ? `Last event received ${new Date(s.webhookSeen).toLocaleString()}.`
    : 'No webhook traffic yet. You can still send — but no delivery ticks, no Conversations, no automatic opt-outs.';

  $('#navSetup').classList.toggle('zero', !!s.connected);
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
  $('#setAccessToken').placeholder = s.accessTokenSet
    ? (s.accessTokenFromEnv ? 'set by the server environment' : `saved (${s.accessTokenTail}) — blank keeps it`)
    : 'EAAG…';
  $('#setAccessToken').disabled = !!s.accessTokenFromEnv;
}

$('#btnSaveSettings').addEventListener('click', async () => {
  const btn = $('#btnSaveSettings');
  btn.disabled = true;
  btn.textContent = 'Testing…';
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
    if (s.connected) await loadTemplates().catch(() => {});
    toast(s.connected ? 'Connected' : 'Saved, but the connection test failed', s.connected ? 'ok' : 'err');
  } catch (err) { toast(err.message, 'err'); }
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

// =============================== contacts ===============================

let contactsCache = [];
const chosenTags = new Set();
const pickedIds = new Set();

function renderTagChips(tags) {
  for (const t of [...chosenTags]) if (!tags.includes(t)) chosenTags.delete(t);
  $('#audTagChips').innerHTML = tags.length
    ? tags.map((t) => `<button type="button" class="chip${chosenTags.has(t) ? ' on' : ''}" data-tag="${esc(t)}">${esc(t)}</button>`).join('')
    : '<span class="hint">No categories yet — tick contacts on the Contacts page and give them a category.</span>';
}

$('#audTagChips').addEventListener('click', (e) => {
  const t = e.target.dataset?.tag;
  if (!t) return;
  if (chosenTags.has(t)) chosenTags.delete(t); else chosenTags.add(t);
  e.target.classList.toggle('on');
  refreshAudience();
});

function hiddenPicked() {
  const visible = new Set($$('.csel').map((b) => b.value));
  return [...pickedIds].filter((id) => !visible.has(id));
}

function syncPicked() {
  const hidden = hiddenPicked().length;
  $('#selCount').innerHTML = `${pickedIds.size} ticked`
    + (hidden ? ` <span style="color:var(--destructive)">(${hidden} hidden by your filter)</span>` : '');
  $('#pickedCount').textContent = pickedIds.size;
}

$('#btnClearSel').addEventListener('click', () => {
  pickedIds.clear();
  $$('.csel').forEach((b) => (b.checked = false));
  $('#selectAll').checked = false;
  syncPicked();
  refreshAudience();
});

async function loadContacts() {
  const params = new URLSearchParams({
    q: $('#searchContacts').value.trim(), tag: $('#filterTag').value, status: $('#filterStatus').value,
  });
  const data = await api(`/contacts?${params}`);
  contactsCache = data.items;

  $('#contactCount').textContent = data.grandTotal.toLocaleString();
  $('#contactSub').textContent = `${data.total.toLocaleString()} shown · ${data.optOuts} unsubscribed · ${data.invalid} invalid`;
  $('#navContacts').textContent = data.grandTotal;
  $('#navContacts').classList.toggle('zero', !data.grandTotal);

  const tagSel = $('#filterTag');
  const current = tagSel.value;
  tagSel.innerHTML = '<option value="">All categories</option>'
    + data.tags.map((t) => `<option${t === current ? ' selected' : ''}>${esc(t)}</option>`).join('');
  renderTagChips(data.tags);

  $('#contactsTable').innerHTML = `
    <thead><tr><th style="width:36px"></th><th>Number</th><th>Name</th><th>Categories</th><th>Status</th><th>Last contacted</th><th></th></tr></thead>
    <tbody>${data.items.map(contactRow).join('')
      || '<tr><td colspan="7" class="table-empty">No contacts yet — import a file above.</td></tr>'}</tbody>`;
  queueMicrotask(syncPicked);
}

function contactRow(c) {
  const status = c.optOut ? '<span class="badge badge-destructive">unsubscribed</span>'
    : c.invalid ? '<span class="badge badge-warning">invalid</span>'
      : '<span class="badge badge-success">active</span>';
  return `<tr>
    <td><input type="checkbox" class="csel" value="${c.id}"${pickedIds.has(c.id) ? ' checked' : ''}></td>
    <td class="mono">+${esc(c.phone)}</td>
    <td>${esc(c.name) || '<span class="muted">—</span>'}</td>
    <td>${(c.tags || []).map((t) => `<span class="badge badge-secondary">${esc(t)}</span>`).join(' ')}</td>
    <td>${status}</td>
    <td class="muted small">${c.lastSentAt ? new Date(c.lastSentAt).toLocaleDateString() : '—'}</td>
    <td><button class="btn btn-ghost btn-sm" data-toggle-optout="${c.id}" data-val="${c.optOut ? 0 : 1}">${c.optOut ? 'Re-subscribe' : 'Unsubscribe'}</button></td>
  </tr>`;
}

const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

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
  if (!ids.length) return toast('Tick some contacts first', 'err');
  const action = b.dataset.bulk;
  let tag;
  if (action === 'tag' || action === 'untag') {
    tag = $('#bulkTag').value.trim();
    if (!tag) return toast('Type a category name first', 'err');
  }
  if (action === 'delete') {
    const hidden = hiddenPicked().length;
    const warn = hidden ? `\n\n${hidden} of them are NOT shown right now — they were ticked before you searched or filtered.` : '';
    if (!await askConfirm(`Delete ${ids.length} contact(s)? This cannot be undone.${warn}`)) return;
  }
  await api('/contacts/bulk', { method: 'POST', body: JSON.stringify({ ids, action, tag }) });
  if (action === 'delete') { pickedIds.clear(); syncPicked(); }
  $('#selectAll').checked = false;
  toast(action === 'tag' ? `${ids.length} contact(s) put in "${tag}"` : 'Done');
  await loadContacts();
  refreshAudience();
}));

const tagList = (v) => v.split(',').map((s) => s.trim()).filter(Boolean);

$('#btnQuickAdd').addEventListener('click', async () => {
  const numbers = $('#quickAdd').value.trim();
  if (!numbers) return;
  const r = await api('/contacts/quick-add', { method: 'POST', body: JSON.stringify({ numbers, tags: tagList($('#importTag').value) }) });
  $('#quickAddResult').textContent = `added ${r.added}, duplicates ${r.duplicate}${r.invalid.length ? `, rejected: ${r.invalid.join(', ')}` : ''}`;
  $('#quickAdd').value = '';
  loadContacts();
});

// ---- import
let importRows = null;
let lastFile = null;

async function runPreview(remap = false) {
  const file = $('#fileInput').files[0] || lastFile;
  if (!file) return toast('Choose a file first', 'err');
  lastFile = file;
  const fd = new FormData();
  fd.append('file', file);
  if (remap) { fd.append('phoneCol', $('#phoneCol').value); fd.append('nameCol', $('#nameCol').value); }

  const res = await fetch('/api/contacts/preview', { method: 'POST', body: fd });
  const data = await res.json();
  if (!res.ok) return toast(data.error || 'Import failed', 'err');

  importRows = data.rows;
  $('#importPreview').classList.remove('hidden');
  if (!$('#importTag2').value) $('#importTag2').value = $('#importTag').value;

  const c = data.counts;
  const stat = (v, label, cls = '') => `<div class="stat"><div class="stat-value sm ${cls}">${v}</div><div class="stat-foot">${label}</div></div>`;
  $('#importCounts').innerHTML = stat(c.total, 'rows in file')
    + stat(c.valid, 'usable numbers', 'status-sent')
    + stat(c.invalid, 'unusable', c.invalid ? 'status-failed' : '')
    + stat(c.duplicateInFile, 'duplicates in file')
    + stat(c.alreadyExists, 'already saved');

  const opts = (sel) => data.headers.map((h) => `<option${h === sel ? ' selected' : ''}>${esc(h)}</option>`).join('');
  $('#phoneCol').innerHTML = opts(data.phoneCol);
  $('#nameCol').innerHTML = `<option value="">— none —</option>${opts(data.nameCol)}`;

  const extra = Object.keys(data.sample[0]?.fields || {}).slice(0, 4);
  $('#previewTable').innerHTML = `
    <thead><tr><th>In your file</th><th>Will send to</th><th>Name</th>${extra.map((k) => `<th>${esc(k)}</th>`).join('')}<th>Note</th></tr></thead>
    <tbody>${data.sample.map((r) => `<tr>
      <td class="muted">${esc(r.raw)}</td>
      <td class="mono ${r.valid ? 'status-sent' : 'status-failed'}">${r.valid ? `+${esc(r.phone)}` : '—'}</td>
      <td>${esc(r.name)}</td>
      ${extra.map((k) => `<td>${esc(r.fields[k])}</td>`).join('')}
      <td class="muted small">${r.valid ? (r.alreadyExists ? 'already saved (will update)' : r.duplicateInFile ? 'duplicate in file' : '') : esc(r.problem)}</td>
    </tr>`).join('')}</tbody>`;
}

$('#btnPreview').addEventListener('click', () => runPreview(false).catch((e) => toast(e.message, 'err')));
$('#btnRemap').addEventListener('click', () => runPreview(true).catch((e) => toast(e.message, 'err')));
$('#btnCancelImport').addEventListener('click', () => { $('#importPreview').classList.add('hidden'); importRows = null; });

$('#btnConfirmImport').addEventListener('click', async () => {
  if (!importRows) return;
  const tags = tagList($('#importTag2').value || $('#importTag').value);
  if (!tags.length && !await askConfirm('Import without a category? You will not be able to target this batch separately later.', 'Import anyway', 'No category set')) return;

  const r = await api('/contacts/import', { method: 'POST', body: JSON.stringify({ rows: importRows, tags }) });
  toast(`Imported ${r.added} new, updated ${r.updated}${tags.length ? ` into "${tags.join(', ')}"` : ''}`);
  $('#importPreview').classList.add('hidden');
  $('#importTag2').value = '';
  importRows = null;
  await loadContacts();
  refreshAudience();
});

// ================================= send =================================

let templates = [];

$('#btnLoadTemplates').addEventListener('click', () => loadTemplates());

async function loadTemplates() {
  try {
    templates = await api('/templates');
    const ok = templates.filter((t) => t.status === 'APPROVED');
    $('#templateSelect').innerHTML = '<option value="">Pick your message…</option>'
      + templates.map((t, i) => `<option value="${i}"${t.status !== 'APPROVED' ? ' disabled' : ''}>${esc(t.name)} · ${t.language}${t.status !== 'APPROVED' ? ` (${t.status})` : ''}</option>`).join('');
    $('#templateStatus').textContent = templates.length
      ? `${ok.length} approved of ${templates.length}`
      : 'Connected, but this account has no templates yet.';
    $('#templateList').innerHTML = templates.length ? `<div class="table-wrap"><table>
      <thead><tr><th>Template</th><th>Language</th><th>Type</th><th>Status</th></tr></thead>
      <tbody>${templates.map((t) => `<tr><td>${esc(t.name)}</td><td>${esc(t.language)}</td>
        <td class="muted">${esc(t.category)}</td>
        <td><span class="badge badge-${t.status === 'APPROVED' ? 'success' : t.status === 'REJECTED' ? 'destructive' : 'warning'}">${esc(t.status)}</span></td></tr>`).join('')}</tbody>
      </table></div>` : '';
  } catch (err) {
    const diag = /error 100|Unsupported get|does not exist/i.test(err.message)
      ? 'That Business Account ID looks wrong — it is not the app ID and not the phone number ID.'
      : /error 200|error 190|permission/i.test(err.message)
        ? 'Your token cannot read templates. Regenerate it with whatsapp_business_management ticked.'
        : '';
    $('#templateStatus').innerHTML = `<span class="status-failed">${esc(err.message)}</span>${diag ? `<br>${esc(diag)}` : ''}`;
    $('#templateSelect').innerHTML = '<option value="">Could not load templates — see Setup</option>';
  }
}

$('#templateSelect').addEventListener('change', () => {
  const t = templates[$('#templateSelect').value];
  if (!t) return;
  $('#templateBody').textContent = t.components.find((c) => c.type === 'BODY')?.text || '(no body)';

  const s = t.shape;
  let html = '';
  if (s.headerType && s.headerType !== 'TEXT') {
    html += `<div class="varrow"><span>${s.headerType.toLowerCase()}</span><input id="hdrMedia" placeholder="public https:// link"></div>`;
  }
  const guess = (token, i) => {
    if (/^\d+$/.test(token)) return i === 0 ? '{{name|client}}' : '';
    return /nom|name|client|prenom/i.test(token) ? '{{name|client}}' : `{{${token}}}`;
  };
  s.headerTokens.forEach((tok, i) => {
    html += `<div class="varrow"><span>title {{${esc(tok)}}}</span><input class="hdrvar" data-name="${esc(tok)}" value="${esc(guess(tok, i))}"></div>`;
  });
  s.bodyTokens.forEach((tok, i) => {
    html += `<div class="varrow"><span>{{${esc(tok)}}}</span><input class="bodyvar" data-name="${esc(tok)}" value="${esc(guess(tok, i))}"></div>`;
  });
  for (const b of s.buttons) {
    if (b.urlVars) html += `<div class="varrow"><span>button link</span><input class="btnvar" data-index="${b.index}" placeholder="e.g. {{phone}}"></div>`;
  }
  $('#templateVars').innerHTML = (html || '<p class="hint">This template has no variables — everyone gets the same text.</p>')
    + (s.bodyTokens.length
      ? `<p class="hint" style="margin-top:8px">Left = the placeholder inside your Meta template (${s.named ? 'named' : 'positional'} format).
         Right = what fills it from your file: a column like <code>{{city}}</code>, or <code>{{name|client}}</code> to fall back.</p>`
      : '');
  refreshAudience();
});

$('#btnAddVariant').addEventListener('click', () => addVariant());
function addVariant(value = '') {
  const div = document.createElement('div');
  div.className = 'varrow';
  div.innerHTML = `<textarea rows="3" class="variant" placeholder="Bonjour {{name|cher client}}, …">${esc(value)}</textarea><button class="btn btn-danger-ghost btn-icon">×</button>`;
  div.querySelector('button').addEventListener('click', () => div.remove());
  $('#variants').appendChild(div);
}
addVariant();

const PRESETS = {
  safe: { minDelaySec: 45, maxDelaySec: 120, batchSize: 25, batchPauseMin: 20, dailyCap: 200, hourlyCap: 40, windowStart: 9, windowEnd: 20, respectWindow: true },
  normal: { minDelaySec: 25, maxDelaySec: 70, batchSize: 40, batchPauseMin: 12, dailyCap: 900, hourlyCap: 120, windowStart: 9, windowEnd: 20, respectWindow: true },
  fast: { minDelaySec: 8, maxDelaySec: 20, batchSize: 100, batchPauseMin: 5, dailyCap: 5000, hourlyCap: 400, windowStart: 8, windowEnd: 21, respectWindow: true },
};

function applyPreset(name) {
  for (const [k, v] of Object.entries(PRESETS[name])) {
    const el = $(`#${k}`);
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = v; else el.value = v;
  }
  $$('.preset').forEach((el) => el.classList.toggle('selected', el.dataset.preset === name));
  refreshAudience();
}
$$('input[name=preset]').forEach((r) => r.addEventListener('change', () => applyPreset(r.value)));

const throttleNow = () => ({
  minDelaySec: +$('#minDelaySec').value, maxDelaySec: +$('#maxDelaySec').value,
  batchSize: +$('#batchSize').value, batchPauseMin: +$('#batchPauseMin').value,
  dailyCap: +$('#dailyCap').value, hourlyCap: +$('#hourlyCap').value,
  respectWindow: $('#respectWindow').checked, windowStart: +$('#windowStart').value, windowEnd: +$('#windowEnd').value,
});

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
  let summary = `About one message every ${gap}s, ${t.batchSize} at a time then a ${t.batchPauseMin} min break. `
    + `Never more than ${t.dailyCap}/day or ${t.hourlyCap}/hour`
    + (t.respectWindow ? `, and only between ${t.windowStart}h and ${t.windowEnd}h.` : ', at any hour.');

  try {
    const { count, total, excluded, sample } = await api('/campaigns/audience-count', {
      method: 'POST', body: JSON.stringify({ audience: campaignPayload().audience }),
    });
    $('#audienceCount').textContent = count.toLocaleString();

    const why = [];
    if (excluded.notInTag) why.push(`${excluded.notInTag} not in the selected categories`);
    if (excluded.notPicked) why.push(`${excluded.notPicked} not ticked`);
    if (excluded.recentlyContacted) why.push(`<b>${excluded.recentlyContacted} contacted in the last ${$('#audCooldown').value} days</b>`);
    if (excluded.optOut) why.push(`${excluded.optOut} unsubscribed`);
    if (excluded.invalid) why.push(`${excluded.invalid} invalid`);
    if (excluded.overLimit) why.push(`${excluded.overLimit} over your limit`);
    $('#audienceWhy').innerHTML = why.length
      ? `Out of ${total} contacts, left out: ${why.join(' · ')}.`
      : `All ${total} of your contacts are included.`;
    $('#audienceSample').innerHTML = sample.length
      ? sample.map((c) => `<span class="badge badge-secondary">${esc(c.name || `+${c.phone}`)}</span>`).join('')
        + (count > sample.length ? `<span class="hint"> +${count - sample.length} more</span>` : '')
      : '';

    const batches = t.batchSize > 0 ? Math.floor(count / t.batchSize) : 0;
    const minutes = (count * gap) / 60 + batches * t.batchPauseMin;
    const hoursPerDay = t.respectWindow ? ((t.windowEnd - t.windowStart + 24) % 24 || 24) : 24;
    const perDay = Math.min(t.dailyCap, hoursPerDay * t.hourlyCap);
    const days = Math.ceil(count / Math.max(1, perDay));
    if (count) {
      summary += `  →  ${count} people takes about ${minutes < 90 ? `${Math.round(minutes)} minutes` : `${(minutes / 60).toFixed(1)} hours`}`
        + `${days > 1 ? `, spread over ~${days} days` : ''}.`;
    }
  } catch { /* best effort */ }
  $('#paceSummary').textContent = summary;
}

['audUsePicked', 'audCooldown', 'audLimit', 'minDelaySec', 'maxDelaySec', 'batchSize', 'batchPauseMin', 'dailyCap', 'hourlyCap', 'respectWindow', 'windowStart', 'windowEnd']
  .forEach((id) => $(`#${id}`)?.addEventListener('change', refreshAudience));

$('#btnPreviewMsg').addEventListener('click', async () => {
  try {
    const r = await api('/preview', { method: 'POST', body: JSON.stringify({ ...campaignPayload(), contactId: contactsCache[0]?.id }) });
    $('#msgPreview').textContent = `${r.contact.name || r.contact.phone} would get:  ${r.preview}`;
  } catch (err) { toast(err.message, 'err'); }
});

$('#btnCreateCampaign').addEventListener('click', async () => {
  try {
    await api('/campaigns', { method: 'POST', body: JSON.stringify(campaignPayload()) });
    toast('Campaign created');
    goto('campaigns');
  } catch (err) {
    $('#createResult').textContent = err.message;
    toast(err.message, 'err');
  }
});

// =============================== campaigns ===============================

let pollTimer = null;

async function loadCampaigns() {
  const list = await api('/campaigns');
  $('#campaignList').innerHTML = list.length
    ? list.map(campaignHtml).join('')
    : '<p class="muted small">Nothing yet. Build one on the New campaign page.</p>';
  clearTimeout(pollTimer);
  if (list.some((c) => c.status === 'running') && currentPage === 'campaigns') {
    pollTimer = setTimeout(loadCampaigns, 4000);
  }
}

function campaignHtml(c) {
  const s = c.stats || {};
  const pct = (n) => `${((n / Math.max(1, s.total)) * 100).toFixed(1)}%`;
  const running = c.status === 'running';
  const badge = { running: 'info', done: 'success', paused: 'warning', stopped: 'destructive', draft: 'outline' }[c.status] || 'outline';
  return `<div class="campaign" data-id="${c.id}" data-name="${esc(c.name)}">
    <div class="campaign-top">
      <div>
        <div class="campaign-name">${esc(c.name)}
          <span class="badge badge-${badge}">${c.status}</span>
          ${c.dryRun ? '<span class="badge badge-secondary">test run</span>' : ''}</div>
        <div class="campaign-meta">${c.mode === 'text' ? 'free text' : `template "${esc(c.template?.name || '')}"`}
          · ${new Date(c.createdAt).toLocaleString()}</div>
      </div>
      <div class="campaign-actions">
        ${running ? '<button class="btn btn-outline btn-sm" data-act="pause">Pause</button>'
          : `<button class="btn btn-primary btn-sm" data-act="start">${s.sent ? 'Resume' : 'Start sending'}</button>`}
        ${['running', 'paused'].includes(c.status) ? '<button class="btn btn-outline btn-sm" data-act="stop">Stop</button>' : ''}
        ${s.failed ? '<button class="btn btn-outline btn-sm" data-act="retry">Retry failed</button>' : ''}
        <button class="btn btn-ghost btn-sm" data-act="open">Details</button>
        <button class="btn btn-danger-ghost btn-sm" data-act="delete">Delete</button>
      </div>
    </div>
    <div class="progress" style="margin-top:12px">
      <i class="seg-sent" style="width:${pct(s.sent)}"></i>
      <i class="seg-failed" style="width:${pct(s.failed)}"></i>
      <i class="seg-skipped" style="width:${pct(s.skipped)}"></i>
    </div>
    <div class="campaign-stats">
      <span><b>${(s.sent || 0).toLocaleString()}</b> sent</span>
      <span><b>${(s.delivered || 0).toLocaleString()}</b> delivered</span>
      <span><b>${(s.read || 0).toLocaleString()}</b> read</span>
      <span><b>${(s.failed || 0).toLocaleString()}</b> failed</span>
      <span><b>${(s.skipped || 0).toLocaleString()}</b> skipped</span>
      <span><b>${(s.pending || 0).toLocaleString()}</b> left</span>
      <span class="muted">of ${(s.total || 0).toLocaleString()}</span>
    </div>
    ${c.runtime?.note ? `<div class="runtime-note"><span class="dot dot-pulse"></span>${esc(c.runtime.note)}</div>` : ''}
    ${c.lastError ? `<div class="runtime-note warn">⚠ ${esc(c.lastError)}</div>` : ''}
  </div>`;
}

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const card = btn.closest('.campaign');
  if (!card) return;
  const id = card.dataset.id;
  const act = btn.dataset.act;
  try {
    if (act === 'open') { goto('campaigns'); return openDetail(id); }
    if (act === 'delete') {
      if (!await askConfirm(`Delete "${card.dataset.name}" and its send log? Your contacts are not affected.`)) return;
      await api(`/campaigns/${id}`, { method: 'DELETE' });
    } else if (act === 'retry') {
      const r = await api(`/campaigns/${id}/retry-failed`, { method: 'POST' });
      toast(`${r.requeued} recipients requeued`);
    } else {
      await api(`/campaigns/${id}/${act}`, { method: 'POST' });
      toast(act === 'start' ? 'Sending started' : `Campaign ${act}d`);
    }
    refreshPage();
  } catch (err) { toast(err.message, 'err'); }
});

let detailId = null;
async function openDetail(id) {
  detailId = id;
  const filter = $('#detailFilter').value;
  const c = await api(`/campaigns/${id}${filter ? `?status=${filter}` : ''}`);
  $('#campaignDetail').classList.remove('hidden');
  $('#detailTitle').textContent = c.name;
  $('#detailSub').textContent = `${c.recipientTotal.toLocaleString()} rows${filter ? ` · ${filter}` : ''}`;
  $('#detailTable').innerHTML = `
    <thead><tr><th>Number</th><th>Name</th><th>Status</th><th>Delivery</th><th>When</th><th>Message / problem</th></tr></thead>
    <tbody>${c.recipients.map((r) => `<tr>
      <td class="mono">+${esc(r.phone)}</td><td>${esc(r.name)}</td>
      <td><span class="badge badge-${r.status === 'sent' ? 'success' : r.status === 'failed' ? 'destructive' : r.status === 'skipped' ? 'warning' : 'outline'}">${r.status}</span></td>
      <td class="muted">${esc(r.delivery || '—')}</td>
      <td class="muted small">${r.at ? new Date(r.at).toLocaleString() : '—'}</td>
      <td class="wrap muted small">${esc(r.error || r.preview || '')}${r.hint ? `<br><b>${esc(r.hint)}</b>` : ''}</td>
    </tr>`).join('') || '<tr><td colspan="6" class="table-empty">Nothing here.</td></tr>'}</tbody>`;
  $('#campaignDetail').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
$('#detailFilter').addEventListener('change', () => detailId && openDetail(detailId));
$('#btnCloseDetail').addEventListener('click', () => $('#campaignDetail').classList.add('hidden'));
$('#btnExport').addEventListener('click', () => detailId && window.open(`/api/campaigns/${detailId}/export`));

// ================================ badges ================================

async function loadBadges() {
  try {
    const convs = await api('/conversations');
    const unread = convs.reduce((n, c) => n + (c.unread || 0), 0);
    $('#navUnread').textContent = unread;
    $('#navUnread').classList.toggle('zero', !unread);
  } catch { /* not critical */ }
}

$('#btnLogout').addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  location.replace('/login.html');
});

// ================================= boot =================================

applyPreset('safe');
(async function boot() {
  await loadSettings().catch(() => {});
  loadDashboard();
  loadBadges();
  loadContacts().catch(() => {});
  loadStatus().then((s) => { if (s?.connected) loadTemplates().catch(() => {}); }).catch(() => {});
  setInterval(loadBadges, 60000);
}());
