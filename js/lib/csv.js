// CSV : lecture robuste (RFC 4180 : guillemets, guillemets échappés, retours ligne dans un champ,
// \r\n, BOM, séparateur ; , ou tabulation détecté) et écriture compatible Excel FR.

/** Détecte le séparateur d'après la première ligne (hors guillemets). */
export function detectSeparator(text) {
  const first = String(text).replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0] || '';
  const count = (ch) => {
    let n = 0, q = false;
    for (const c of first) { if (c === '"') q = !q; else if (c === ch && !q) n++; }
    return n;
  };
  const cands = [[';', count(';')], [',', count(',')], ['\t', count('\t')]];
  cands.sort((a, b) => b[1] - a[1]);
  return cands[0][1] > 0 ? cands[0][0] : ';';
}

/** Découpe le texte en enregistrements `{ fields, line }` (`line` = n° de ligne source, 1 = première). */
function scan(text, sep) {
  const src = String(text ?? '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n'); // fins de ligne normalisées
  const records = [];
  let rec = [], field = '', inQuotes = false, i = 0, touched = false, line = 1, recLine = 1;
  const endField = () => { rec.push(field); field = ''; };
  const endRecord = () => {
    endField();
    if (rec.some((f) => f.trim() !== '') || touched) records.push({ fields: rec.map((f) => f.trim()), line: recLine });
    rec = []; touched = false;
  };
  while (i < src.length) {
    const c = src[i];
    if (c === '\n') line++;
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; touched = true; i++; continue; }
    if (c === sep) { endField(); touched = true; i++; continue; }
    if (c === '\n') { endRecord(); recLine = line; i++; continue; }
    field += c; touched = true; i++;
  }
  if (field !== '' || rec.length || touched) endRecord();
  return records.filter((r) => r.fields.some((f) => f !== ''));
}

/** Découpe tout le texte en enregistrements (tableaux de champs). */
export function parseRecords(text, sep = detectSeparator(text)) {
  return scan(text, sep).map((r) => r.fields);
}

/** En-tête normalisé : minuscules, sans accents ni ponctuation (« Désignation » → « designation »). */
export const normHeader = (h) =>
  String(h ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Texte CSV → { headers, rows:[{col:valeur}], line } ; `line` = n° de ligne source (1 = en-tête). */
export function parse(text) {
  const records = scan(text, detectSeparator(text));
  if (!records.length) return { headers: [], rows: [] };
  const headers = records[0].fields.map(normHeader);
  const rows = records.slice(1).map(({ fields, line }) => {
    const o = { _line: line };
    headers.forEach((h, i) => { if (h) o[h] = fields[i] ?? ''; });
    return o;
  });
  return { headers: headers.filter(Boolean), rows };
}

/** Neutralise l'injection de formules (=, +, -, @, tab, CR) à l'ouverture dans un tableur. */
export const safeCell = (v) => {
  const s = String(v ?? '');
  return /^[=+\-@\t\r]/.test(s) && !/^[+-]?\d+([.,]\d+)?$/.test(s) ? `'${s}` : s;
};

const quote = (s, sep) => (/["\r\n]/.test(s) || s.includes(sep) ? `"${s.replace(/"/g, '""')}"` : s);

/**
 * Objets → texte CSV. `columns` : [{key,label,get?}] ; séparateur « ; » et BOM par défaut
 * (ouverture directe dans Excel en français).
 */
export function stringify(rows, columns, { sep = ';', bom = true } = {}) {
  const lines = [columns.map((c) => quote(String(c.label), sep)).join(sep)];
  for (const r of rows) {
    lines.push(columns.map((c) => quote(safeCell(c.get ? c.get(r) : r[c.key]), sep)).join(sep));
  }
  return (bom ? '\uFEFF' : '') + lines.join('\r\n') + '\r\n';
}
