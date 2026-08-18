const $ = (s) => document.querySelector(s);
const fail = (m) => { $('#err').textContent = m; };

async function post(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

(async function init() {
  const s = await fetch('/api/auth/status').then((r) => r.json());
  if (s.signedIn) return location.replace('/');
  $(s.passwordSet ? '#loginMode' : '#setupMode').classList.remove('hidden');
  if (s.envPassword) {
    $('#envNote').textContent = 'This app is using the password from its APP_PASSWORD environment variable, not one chosen here.';
    $('#envNote').classList.remove('hidden');
  }
  $(s.passwordSet ? '#password' : '#newPassword').focus();
}());

$('#btnSetup').addEventListener('click', async () => {
  const a = $('#newPassword').value;
  const b = $('#newPassword2').value;
  if (a !== b) return fail('The two passwords do not match.');
  if (a.length < 8) return fail('Use at least 8 characters.');
  try {
    await post('/api/auth/setup', { password: a });
    location.replace('/');
  } catch (err) { fail(err.message); }
});

$('#btnLogin').addEventListener('click', async () => {
  try {
    await post('/api/auth/login', { password: $('#password').value });
    location.replace('/');
  } catch (err) { fail(err.message); }
});

for (const id of ['password', 'newPassword2']) {
  $(`#${id}`).addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    ($('#loginMode').classList.contains('hidden') ? $('#btnSetup') : $('#btnLogin')).click();
  });
}
