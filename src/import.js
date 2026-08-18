// Turn an uploaded CSV / XLSX / pasted text into contact rows.
import { parse } from 'csv-parse/sync';
import ExcelJS from 'exceljs';
import { normalizePhone } from './phone.js';

const PHONE_KEYS = ['phone', 'telephone', 'téléphone', 'tel', 'tél', 'mobile', 'gsm', 'whatsapp', 'number', 'numero', 'numéro', 'phone number', 'contact', 'msisdn', 'هاتف', 'الهاتف'];
const NAME_KEYS = ['name', 'nom', 'fullname', 'full name', 'client', 'customer', 'firstname', 'first name', 'prenom', 'prénom', 'nom complet', 'الاسم'];

const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ');

function guessColumn(headers, candidates) {
  const h = headers.map(norm);
  for (const c of candidates) {
    const i = h.indexOf(c);
    if (i !== -1) return headers[i];
  }
  for (const c of candidates) {
    const i = h.findIndex((x) => x.includes(c));
    if (i !== -1) return headers[i];
  }
  return null;
}

/** Rows of plain objects from a buffer, whatever the format. */
export async function parseFile(buffer, filename) {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  if (ext === 'xlsx' || ext === 'xlsm') return parseXlsx(buffer);
  return parseCsv(buffer.toString('utf8'));
}

export function parseCsv(text) {
  // Strip BOM, then let csv-parse sniff , ; or tab.
  const clean = text.replace(/^﻿/, '');
  const sample = clean.split(/\r?\n/)[0] || '';
  const delimiter = [';', '\t', ','].find((d) => sample.includes(d)) || ',';
  return parse(clean, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
    delimiter,
    bom: true,
  });
}

async function parseXlsx(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.worksheets[0];
  if (!ws) return [];
  const headers = [];
  ws.getRow(1).eachCell({ includeEmpty: true }, (cell, col) => {
    headers[col] = String(cellText(cell) || `col${col}`).trim();
  });
  const rows = [];
  ws.eachRow({ includeEmpty: false }, (row, n) => {
    if (n === 1) return;
    const obj = {};
    let any = false;
    row.eachCell({ includeEmpty: true }, (cell, col) => {
      const key = headers[col];
      if (!key) return;
      const v = cellText(cell);
      if (v !== '' && v !== null && v !== undefined) any = true;
      obj[key] = v;
    });
    if (any) rows.push(obj);
  });
  return rows;
}

function cellText(cell) {
  const v = cell?.value;
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    if (v.text) return v.text;
    if (v.result !== undefined) return v.result;
    if (v.richText) return v.richText.map((r) => r.text).join('');
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    return String(v);
  }
  return v;
}

/** Map raw rows onto contact shape, normalising and flagging problems. */
export function mapRows(rows, { phoneCol, nameCol, defaultCountryCode, tags = [] }) {
  const headers = rows.length ? Object.keys(rows[0]) : [];
  const pCol = phoneCol || guessColumn(headers, PHONE_KEYS);
  const nCol = nameCol || guessColumn(headers, NAME_KEYS);

  const out = [];
  for (const row of rows) {
    const rawPhone = pCol ? row[pCol] : Object.values(row)[0];
    const res = normalizePhone(rawPhone, defaultCountryCode);
    const fields = {};
    for (const [k, v] of Object.entries(row)) {
      if (k === pCol) continue;
      const key = norm(k).replace(/\s+/g, '_');
      if (key) fields[key] = typeof v === 'string' ? v.trim() : v;
    }
    out.push({
      phone: res.phone || '',
      raw: String(rawPhone ?? ''),
      name: nCol ? String(row[nCol] ?? '').trim() : '',
      fields,
      tags: [...tags],
      valid: res.ok,
      problem: res.ok ? null : res.reason,
    });
  }
  return { rows: out, phoneCol: pCol, nameCol: nCol, headers };
}

export { guessColumn, PHONE_KEYS, NAME_KEYS };
