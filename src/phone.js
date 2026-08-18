// Phone normalisation to bare E.164 digits (no '+'), which is the format the
// Cloud API expects in the `to` field.

const COUNTRY_TRUNK_PREFIX = {
  // Countries where subscribers write a leading 0 that must be dropped.
  212: '0', // Morocco
  213: '0', // Algeria
  216: '', // Tunisia — no trunk prefix
  33: '0', // France
  32: '0', // Belgium
  34: '', // Spain
  39: '', // Italy
  44: '0', // UK
  49: '0', // Germany
  971: '0', // UAE
  966: '0', // Saudi Arabia
  20: '0', // Egypt
  1: '', // NANP
};

export function normalizePhone(raw, defaultCountryCode = '212') {
  if (raw === null || raw === undefined) return { ok: false, reason: 'empty' };

  let s = String(raw).trim();
  if (!s) return { ok: false, reason: 'empty' };

  // Excel loves turning phone columns into 2.126612e+11 or 612345678.0
  if (/e\+/i.test(s) && !Number.isNaN(Number(s))) s = BigInt(Math.round(Number(s))).toString();
  s = s.replace(/\.0+$/, '');

  const hadPlus = s.trim().startsWith('+');
  let digits = s.replace(/\D/g, '');
  if (!digits) return { ok: false, reason: 'no digits' };

  const cc = String(defaultCountryCode).replace(/\D/g, '');

  if (!hadPlus) {
    if (digits.startsWith('00')) {
      digits = digits.slice(2); // international 00 prefix
    } else if (cc && digits.startsWith(cc) && digits.length > cc.length + 6) {
      // Already carries the country code.
    } else {
      const trunk = COUNTRY_TRUNK_PREFIX[Number(cc)] ?? '0';
      if (trunk && digits.startsWith(trunk)) digits = digits.slice(trunk.length);
      digits = cc + digits;
    }
  }

  if (digits.length < 8 || digits.length > 15) return { ok: false, reason: `bad length (${digits.length})`, phone: digits };
  return { ok: true, phone: digits };
}

export function prettyPhone(digits) {
  return `+${digits}`;
}
