// Clears the app's login password so the "Choose a password" screen comes back.
//   node scripts/reset-password.mjs
// Restart the app afterwards — settings are cached in memory while it runs.
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_KEY in .env first.');
  process.exit(1);
}
const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

const { data, error } = await sb.from('app_settings').select('data').eq('id', 1).maybeSingle();
if (error) { console.error(error.message); process.exit(1); }

const settings = { ...(data?.data || {}) };
const had = !!settings.authHash;
delete settings.authHash;
delete settings.authSalt;

await sb.from('app_settings').upsert({ id: 1, data: settings });
await sb.from('sessions').delete().neq('token', ''); // sign every device out

console.log(had ? 'Password cleared.' : 'There was no password set.');
console.log('Sessions cleared. Restart the app, then choose a new password in the browser.');
console.log('Your contacts, campaigns and logs are untouched.');
