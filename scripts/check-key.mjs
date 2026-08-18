// Confirms you put the right Supabase key in .env, without printing the key.
//   node scripts/check-key.mjs
import 'dotenv/config';

const url = process.env.SUPABASE_URL || '';
const key = process.env.SUPABASE_SERVICE_KEY || '';

console.log(`SUPABASE_URL          ${url || 'MISSING'}`);
if (!key) {
  console.log('SUPABASE_SERVICE_KEY  MISSING — paste your service_role key into .env');
  process.exit(1);
}

let role = 'unknown';
if (key.startsWith('sb_secret_')) role = 'service_role (new format)';
else if (key.startsWith('sb_publishable_')) role = 'publishable';
else if (key.split('.').length === 3) {
  try {
    role = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString()).role || 'unknown';
  } catch { /* not a readable JWT */ }
}

console.log(`SUPABASE_SERVICE_KEY  present (${key.length} chars), role: ${role}`);

if (!/service_role|sb_secret/.test(role)) {
  console.log('\n  WRONG KEY. This is a browser key — it cannot read your tables through RLS.');
  console.log('  Supabase → Project Settings → API → service_role → Reveal, and use that one.\n');
  process.exit(1);
}

// Right role — now prove it actually reaches the database and the tables exist.
const { createClient } = await import('@supabase/supabase-js');
const sb = createClient(url, key, { auth: { persistSession: false } });

for (const table of ['app_settings', 'contacts', 'campaigns', 'recipients', 'send_log', 'inbox', 'sessions']) {
  const { count, error } = await sb.from(table).select('*', { count: 'exact', head: true });
  if (error) {
    console.log(`  ${table.padEnd(13)} ERROR: ${error.message}`);
    if (/does not exist|schema cache/i.test(error.message)) {
      console.log('\n  Run supabase/schema.sql in the Supabase SQL Editor first.\n');
      process.exit(1);
    }
  } else {
    console.log(`  ${table.padEnd(13)} ok (${count} rows)`);
  }
}
console.log('\nDatabase is reachable and the tables exist.');
