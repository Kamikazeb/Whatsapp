// Reports whether your Meta token expires, without printing the token.
//   node scripts/check-token.mjs
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
const { data } = await sb.from('app_settings').select('data').eq('id', 1).maybeSingle();
const token = process.env.WA_ACCESS_TOKEN || data?.data?.accessToken || '';

if (!token) {
  console.log('No token configured.');
  process.exit(1);
}
console.log(`Source: ${process.env.WA_ACCESS_TOKEN ? 'WA_ACCESS_TOKEN env var' : 'database'}  (${token.length} chars)`);

const url = `https://graph.facebook.com/debug_token?input_token=${encodeURIComponent(token)}&access_token=${encodeURIComponent(token)}`;
const res = await fetch(url);
const body = await res.json();

if (body.error) {
  console.log(`\nMeta says: ${body.error.message} (code ${body.error.code})`);
  process.exit(1);
}

const d = body.data || {};
console.log(`Valid       : ${d.is_valid}`);
console.log(`Type        : ${d.type || 'unknown'}`);
console.log(`App ID      : ${d.app_id || '—'}`);
console.log(`Scopes      : ${(d.scopes || []).join(', ') || '—'}`);

if (!d.expires_at || d.expires_at === 0) {
  console.log('\nExpires     : NEVER — this is a permanent token. Nothing to do.');
} else {
  const when = new Date(d.expires_at * 1000);
  const days = Math.round((when - Date.now()) / 86400000);
  console.log(`\nExpires     : ${when.toLocaleString()}  (${days} day(s) away)`);
  console.log('This is a TEMPORARY token. Replace it with a System User token.');
}
