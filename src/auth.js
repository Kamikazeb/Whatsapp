// Password login. Mandatory once this app is reachable from the internet: without
// it, anyone with the URL can read the client list and send messages on your number.
import { randomBytes, scryptSync, timingSafeEqual, createHmac } from 'node:crypto';
import { settings, saveSettings, createSession, sessionValid, deleteSession, deleteAllSessions, pruneSessions } from './data.js';

const SESSION_DAYS = 30;
const MAX_FAILS = 10;
const LOCK_MINUTES = 15;

const fails = new Map(); // ip -> { count, until }

function hashPassword(password, salt) {
  return scryptSync(String(password), salt, 64).toString('hex');
}

export function passwordIsSet() {
  return !!(process.env.APP_PASSWORD || settings().authHash);
}

export async function setPassword(password) {
  if (!password || String(password).length < 8) {
    throw Object.assign(new Error('Password must be at least 8 characters.'), { status: 400 });
  }
  const salt = randomBytes(16).toString('hex');
  await saveSettings({ authSalt: salt, authHash: hashPassword(password, salt) });
  await deleteAllSessions(); // changing the password signs every device out
}

function passwordMatches(password) {
  // An env password wins, so a hosted deploy can be configured without the UI.
  if (process.env.APP_PASSWORD) {
    const a = Buffer.from(String(password));
    const b = Buffer.from(process.env.APP_PASSWORD);
    return a.length === b.length && timingSafeEqual(a, b);
  }
  const { authHash, authSalt } = settings();
  if (!authHash || !authSalt) return false;
  const candidate = Buffer.from(hashPassword(password, authSalt), 'hex');
  const stored = Buffer.from(authHash, 'hex');
  return candidate.length === stored.length && timingSafeEqual(candidate, stored);
}

// ---- sessions -------------------------------------------------------------

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

async function newSession() {
  await pruneSessions();
  const token = randomBytes(32).toString('hex');
  await createSession(token, Date.now() + SESSION_DAYS * 86400000);
  return token;
}

export async function isAuthed(req) {
  const token = parseCookies(req.headers.cookie).wa_session;
  if (!token) return false;
  return sessionValid(token);
}

function cookieOptions(req) {
  // Behind nginx/hPanel the app itself sees http, so trust the proxy header.
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure ? '; Secure' : ''}`;
}

// ---- middleware + routes --------------------------------------------------

// Meta must reach the webhook unauthenticated; it is verified by its own token
// (and optionally by an HMAC signature — see verifyWebhookSignature).
// The sign-in page needs its own assets, or it renders unstyled with a broken logo.
const PUBLIC_PATHS = new Set([
  '/login.html', '/login.js', '/styles.css', '/logo.svg', '/favicon.ico',
  '/webhook', '/api/auth/status', '/api/auth/login', '/api/auth/setup',
]);

export async function requireAuth(req, res, next) {
  try {
    if (PUBLIC_PATHS.has(req.path) || req.path.startsWith('/webhook')) return next();
    if (await isAuthed(req)) return next();
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not signed in.' });
    return res.redirect('/login.html');
  } catch (err) {
    next(err);
  }
}

export function mountAuthRoutes(app) {
  app.get('/api/auth/status', async (req, res) => {
    res.json({ passwordSet: passwordIsSet(), signedIn: await isAuthed(req), envPassword: !!process.env.APP_PASSWORD });
  });

  // First run only: choose the password from the browser.
  app.post('/api/auth/setup', async (req, res) => {
    if (passwordIsSet()) return res.status(400).json({ error: 'A password is already set.' });
    try {
      await setPassword(req.body.password);
      res.setHeader('Set-Cookie', `wa_session=${await newSession()}; ${cookieOptions(req)}`);
      res.json({ ok: true });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.post('/api/auth/login', async (req, res) => {
    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
    const record = fails.get(ip);
    if (record?.until > Date.now()) {
      const mins = Math.ceil((record.until - Date.now()) / 60000);
      return res.status(429).json({ error: `Too many failed attempts. Try again in ${mins} minute(s).` });
    }
    if (!passwordIsSet()) return res.status(400).json({ error: 'No password set yet.' });

    if (!passwordMatches(req.body.password || '')) {
      const count = (record?.count || 0) + 1;
      fails.set(ip, { count, until: count >= MAX_FAILS ? Date.now() + LOCK_MINUTES * 60000 : 0 });
      // An APP_PASSWORD in the environment silently overrides any password chosen
      // in the browser — say so, or a correct password looks mysteriously wrong.
      const hint = process.env.APP_PASSWORD && settings().authHash
        ? ' This app is currently using the password from its APP_PASSWORD environment variable, which overrides the one set in the browser.'
        : '';
      return res.status(401).json({ error: `Wrong password.${hint}` });
    }
    fails.delete(ip);
    res.setHeader('Set-Cookie', `wa_session=${await newSession()}; ${cookieOptions(req)}`);
    res.json({ ok: true });
  });

  app.post('/api/auth/logout', async (req, res) => {
    const token = parseCookies(req.headers.cookie).wa_session;
    if (token) await deleteSession(token);
    res.setHeader('Set-Cookie', 'wa_session=; Path=/; HttpOnly; Max-Age=0');
    res.json({ ok: true });
  });

  app.post('/api/auth/change-password', async (req, res) => {
    if (!await isAuthed(req)) return res.status(401).json({ error: 'Not signed in.' });
    if (process.env.APP_PASSWORD) return res.status(400).json({ error: 'Password comes from the APP_PASSWORD environment variable — change it there.' });
    if (!passwordMatches(req.body.current || '')) return res.status(401).json({ error: 'Current password is wrong.' });
    try {
      await setPassword(req.body.next);
      res.setHeader('Set-Cookie', `wa_session=${await newSession()}; ${cookieOptions(req)}`);
      res.json({ ok: true });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });
}

/**
 * Meta signs every webhook with your app secret. When WA_APP_SECRET is set we
 * reject anything that doesn't match, so nobody can forge opt-outs or statuses.
 */
export function verifyWebhookSignature(req) {
  const secret = process.env.WA_APP_SECRET;
  if (!secret) return true; // not configured — fall back to the verify token alone
  const header = req.headers['x-hub-signature-256'];
  if (!header || !req.rawBody) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(req.rawBody).digest('hex')}`;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
