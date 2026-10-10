// Requêtes dérivées (lecture seule) : listes, indicateurs, séries, plan, réassort.
// Fonctions pures : (db, paramètres, now) → données. Aucune écriture, aucun accès au DOM.
import { LIMITS } from './config.js';
import { matches, natCompare as nat } from '../lib/text.js';
import { isCode, codeVariants } from '../lib/ean.js';

const DAY = 86_400_000;

// ── Éléments de base ──
export const locCode = (l) => (l ? [l.rack, l.allee, l.etagere, l.case].filter(Boolean).join('-') : '');
export const stockOf = (db, depotId, ean) => db.stocks[depotId]?.[ean] ?? 0;
export const totalStock = (db, ean) => Object.keys(db.depots).reduce((s, d) => s + stockOf(db, d, ean), 0);
/**
 * Seuils d'un article DANS un dépôt : réglage propre au dépôt (seuils intelligents appliqués, saisie manuelle)
 * sinon seuil par défaut de la fiche article (max = 2 × min).
 * @returns {{min:number, max:number, source:'depot'|'article'}}
 */
export function levelOf(db, depotId, article) {
  const o = db.levels?.[depotId]?.[article.ean];
  if (o) return { min: o.min, max: Math.max(o.min, o.max), source: 'depot' };
  const min = article.threshold || 0;
  return { min, max: min * 2, source: 'article' };
}
/** Sous le seuil (minimum) ? Un seuil à 0 = article non suivi. */
export const isLow = (min, qty) => min > 0 && qty <= min;
/** 'zero' (épuisé) · 'low' (sous le seuil) · 'ok' */
export const stockStatus = (min, qty) => (qty === 0 ? 'zero' : isLow(min, qty) ? 'low' : 'ok');
/** Raccourci : statut d'un article dans un dépôt. */
export const statusIn = (db, depotId, article) => stockStatus(levelOf(db, depotId, article).min, stockOf(db, depotId, article.ean));

/** Emplacements d'un article dans un dépôt, l'emplacement par défaut en premier. */
export function articleLocations(db, ean, depotId) {
  const ids = db.articles[ean]?.locations?.[depotId] ?? [];
  return ids.map((id) => db.locations[id]).filter(Boolean);
}

/**
 * Code lu → code de la pièce au catalogue : le code exact, sinon une écriture équivalente (UPC-A / EAN-13 /
 * GTIN-14, voir codeVariants). null si aucune pièce ne correspond.
 */
export function resolveEan(db, code) {
  const s = String(code ?? '').trim();
  if (!isCode(s)) return null;
  if (Object.hasOwn(db.articles, s)) return s;
  return codeVariants(s).find((v) => Object.hasOwn(db.articles, v)) ?? null;
}

export const families = (db) => [...new Set(Object.values(db.articles).map((a) => a.family).filter(Boolean))].sort(nat);

/** Tous les codes d'emplacement d'un dépôt (suggestions de saisie). */
export const depotLocationCodes = (db, depotId) =>
  Object.values(db.locations).filter((l) => l.depotId === depotId).map(locCode).sort(nat);

// ── Liste d'articles ──
/**
 * @param {{q?:string, filter?:'all'|'alert'|'zero', family?:string, sort?:'loc'|'name'|'qty-asc'|'qty-desc'}} opt
 * @returns {{article:object, qty:number, status:string, locs:object[]}[]}
 */
export function searchArticles(db, depotId, { q = '', filter = 'all', family = '', sort = 'loc' } = {}) {
  const rows = [];
  for (const article of Object.values(db.articles)) {
    const qty = stockOf(db, depotId, article.ean);
    const { min, max } = levelOf(db, depotId, article);
    const status = stockStatus(min, qty);
    if (filter === 'alert' && !isLow(min, qty)) continue;
    if (filter === 'zero' && qty !== 0) continue;
    if (family && article.family !== family) continue;
    const locs = articleLocations(db, article.ean, depotId);
    if (q && !matches(q, article.name, article.ean, article.ref, article.family, locs.map(locCode).join(' '))) continue;
    rows.push({ article, qty, status, locs, min, max });
  }
  const code = (r) => (r.locs[0] ? locCode(r.locs[0]) : '￿');
  const cmp = {
    loc: (a, b) => nat(code(a), code(b)) || nat(a.article.name, b.article.name),
    name: (a, b) => nat(a.article.name, b.article.name),
    'qty-asc': (a, b) => a.qty - b.qty || nat(a.article.name, b.article.name),
    'qty-desc': (a, b) => b.qty - a.qty || nat(a.article.name, b.article.name),
  }[sort] ?? (() => 0);
  return rows.sort(cmp);
}

// ── Sens d'un mouvement (indicateurs) ──
const VOID_TRANSFER = new Set(['cancelled', 'refused']);
/**
 * Sens d'un mouvement pour les indicateurs : 'in' (entrée, livraison reçue de l'entrepôt ou d'un autre dépôt),
 * 'out' (sortie, expédition à un atelier, transfert vers un autre dépôt) ou null. Ne comptent pas : les
 * corrections d'inventaire, un mouvement annulé et son annulation, un transfert annulé ou refusé et son retour.
 */
export function flowOf(db, h) {
  if (h.undone || h.undoOf) return null;
  switch (h.type) {
    case 'in': case 'transfer_in': return 'in';
    case 'out': return 'out';
    case 'transfer': return h.transferId && VOID_TRANSFER.has(db.transfers?.[h.transferId]?.status) ? null : 'out';
    default: return null;
  }
}

// ── Indicateurs ──
export function kpis(db, depotId, { days = 30, now = new Date() } = {}) {
  const since = now.getTime() - days * DAY;
  let units = 0, value = 0, alerts = 0, zeros = 0, tracked = 0, healthy = 0;
  const arts = Object.values(db.articles);
  for (const a of arts) {
    const q = stockOf(db, depotId, a.ean);
    units += q; value += q * (a.price || 0);
    const { min } = levelOf(db, depotId, a);
    if (isLow(min, q)) alerts++;
    if (q === 0) zeros++;
    if (min > 0) { tracked++; if (q > min) healthy++; }
  }
  let ins = 0, outs = 0, moves = 0, net = 0;
  for (const h of db.history) {
    if (h.depotId !== depotId || new Date(h.date).getTime() < since) continue;
    moves++; net += h.delta;
    const dir = flowOf(db, h);
    if (dir === 'in') ins += h.qty; else if (dir === 'out') outs += h.qty;
  }
  return { refs: arts.length, units, value, alerts, zeros, serviceRate: tracked ? Math.round((healthy / tracked) * 100) : 100, ins, outs, moves, net };
}

export function movesToday(db, depotId, now = new Date()) {
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  return db.history.filter((h) => h.depotId === depotId && new Date(h.date) >= start).length;
}

const endOfDay = (d) => { const e = new Date(d); e.setHours(23, 59, 59, 999); return e; };
const label = (d) => `${d.getDate()}/${d.getMonth() + 1}`;

/**
 * Stock total à la fin de chaque jour (remonte l'historique depuis le stock courant).
 * `truncated` : l'historique conservé ne couvre pas toute la fenêtre (courbe approximative au début).
 */
export function evolution(db, depotId, { days = 30, now = new Date() } = {}) {
  let running = 0;
  for (const v of Object.values(db.stocks[depotId] ?? {})) running += v;
  const entries = db.history.filter((h) => h.depotId === depotId); // déjà du plus récent au plus ancien
  const points = [];
  let i = 0;
  for (let k = 0; k < days; k++) {
    const day = new Date(now.getTime() - k * DAY);
    const end = k === 0 ? now : endOfDay(day);
    while (i < entries.length && new Date(entries[i].date) > end) { running -= entries[i].delta; i++; }
    points.push({ date: day, label: label(day), value: Math.max(0, running) });
  }
  points.reverse();
  const oldest = entries.length ? new Date(entries.at(-1).date).getTime() : Infinity;
  const truncated = db.history.length >= LIMITS.history && oldest > now.getTime() - days * DAY;
  return { points, truncated };
}

/** Entrées / sorties par jour (≤ 31 j) ou par semaine (au-delà). */
export function flow(db, depotId, { days = 30, now = new Date() } = {}) {
  const bucket = days <= 31 ? 1 : 7;
  const n = Math.ceil(days / bucket);
  const buckets = Array.from({ length: n }, (_, i) => {
    const end = new Date(now.getTime() - (n - 1 - i) * bucket * DAY);
    return { label: label(end), ins: 0, outs: 0, endMs: i === n - 1 ? now.getTime() : endOfDay(end).getTime() };
  });
  const start = buckets[0].endMs - bucket * DAY;
  for (const h of db.history) {
    if (h.depotId !== depotId) continue;
    const dir = flowOf(db, h);
    if (!dir) continue;
    const t = new Date(h.date).getTime();
    if (t <= start) continue;
    const b = buckets.find((x) => t <= x.endMs);
    if (!b) continue;
    if (dir === 'in') b.ins += h.qty; else b.outs += h.qty;
  }
  return buckets;
}

export function heatmap(db, depotId, { days = 30, now = new Date() } = {}) {
  const since = now.getTime() - days * DAY;
  const grid = Array.from({ length: 7 }, () => new Array(24).fill(0));
  let max = 0;
  for (const h of db.history) {
    if (h.depotId !== depotId) continue;
    const d = new Date(h.date);
    if (d.getTime() < since) continue;
    const v = ++grid[(d.getDay() + 6) % 7][d.getHours()];
    if (v > max) max = v;
  }
  return { grid, max };
}

export function topArticles(db, depotId, { days = 30, now = new Date(), n = 5 } = {}) {
  const since = now.getTime() - days * DAY;
  const m = new Map();
  for (const h of db.history) {
    if (h.depotId !== depotId || h.type === 'inv' || new Date(h.date).getTime() < since) continue;
    const e = m.get(h.ean) ?? { ean: h.ean, name: db.articles[h.ean]?.name ?? h.name, units: 0, moves: 0 };
    e.units += h.qty; e.moves++;
    m.set(h.ean, e);
  }
  return [...m.values()].sort((a, b) => b.units - a.units).slice(0, n);
}

export function operatorStats(db, depotId, { days = 30, now = new Date(), n = 5 } = {}) {
  const since = now.getTime() - days * DAY;
  const m = new Map();
  for (const h of db.history) {
    if (h.depotId !== depotId || !h.operator || new Date(h.date).getTime() < since) continue;
    const e = m.get(h.operator) ?? { name: h.operator, moves: 0, ins: 0, outs: 0 };
    e.moves++;
    const dir = flowOf(db, h);
    if (dir === 'in') e.ins += h.qty; else if (dir === 'out') e.outs += h.qty;
    m.set(h.operator, e);
  }
  return [...m.values()].sort((a, b) => b.moves - a.moves).slice(0, n);
}

export function depotComparison(db, now = new Date()) {
  return Object.values(db.depots).map((d) => {
    const k = kpis(db, d.id, { days: 30, now });
    return { depot: d, units: k.units, alerts: k.alerts, refs: Object.values(db.stocks[d.id] ?? {}).filter((q) => q > 0).length, value: k.value };
  });
}

// ── Réassort ──
const OPEN_INTERNAL = ['draft', 'submitted', 'picking', 'shipped'];
const OPEN_SUPPLIER = ['sent', 'partial'];
/**
 * Quantité déjà en route vers un dépôt pour un article : commandes internes envoyées/en préparation
 * (quantité demandée), expédiées (quantité expédiée non encore reçue), commandes fournisseurs ouvertes
 * (reste à recevoir). `withDraft` : compte aussi le brouillon (ne pas proposer deux fois la même pièce).
 */
export function incomingQty(db, depotId, ean, { withDraft = false } = {}) {
  return incomingIndex(db, depotId, { withDraft, ean }).get(ean) ?? 0;
}

/**
 * Quantités en route vers un dépôt, pour TOUS les articles en un seul parcours des commandes (Map ean → qté).
 * À préférer à `incomingQty` dans une boucle sur les articles : les commandes ne sont lues qu'une fois.
 * `ean` : ne compter que cet article (raccourci de `incomingQty`).
 */
export function incomingIndex(db, depotId, { withDraft = false, ean = null } = {}) {
  const out = new Map();
  for (const o of Object.values(db.orders ?? {})) {
    if (o.depotId !== depotId) continue;
    if (o.kind === 'internal' ? !OPEN_INTERNAL.includes(o.status) || (o.status === 'draft' && !withDraft) : !OPEN_SUPPLIER.includes(o.status)) continue;
    for (const l of o.lines) {
      if (ean !== null && l.ean !== ean) continue;
      const n = o.kind === 'supplier' ? Math.max(0, l.qty - (l.received ?? 0))
        : o.status === 'shipped' ? Math.max(0, (l.shipped ?? 0) - (l.received ?? 0)) : l.qty;
      if (n) out.set(l.ean, (out.get(l.ean) ?? 0) + n);
    }
  }
  return out;
}
const roundUp = (n, pack) => (pack > 1 ? Math.ceil(n / pack) * pack : n);

/**
 * Réassort : articles sous leur seuil (en tenant compte de ce qui est déjà en route), quantité suggérée
 * pour remonter au maximum, arrondie au conditionnement.
 */
export function reorderList(db, depotId, { withDraft = false } = {}) {
  const rows = [];
  const route = incomingIndex(db, depotId, { withDraft });
  for (const a of Object.values(db.articles)) {
    const qty = stockOf(db, depotId, a.ean);
    const { min, max } = levelOf(db, depotId, a);
    if (min <= 0) continue;
    const incoming = route.get(a.ean) ?? 0;
    if (qty + incoming > min) continue;
    const suggested = roundUp(Math.max(1, max - qty - incoming), a.pack || 1);
    rows.push({ article: a, qty, min, max, threshold: min, target: max, incoming, suggested, cost: suggested * (a.price || 0), locs: articleLocations(db, a.ean, depotId) });
  }
  return rows.sort((x, y) => x.qty / x.min - y.qty / y.min || nat(x.article.name, y.article.name));
}

// ── Plan des emplacements ──
/**
 * Modèle de la cartographie : racks → allées (lignes) × étagère/case (colonnes).
 * État d'une cellule : empty (aucune référence) · zero (références à 0) · alert · ok.
 */
export function planModel(db, depotId) {
  const locs = Object.values(db.locations).filter((l) => l.depotId === depotId);
  // Articles rangés à chaque emplacement, en un seul parcours du catalogue
  const byLoc = new Map();
  for (const a of Object.values(db.articles)) {
    for (const id of a.locations?.[depotId] ?? []) {
      if (!byLoc.has(id)) byLoc.set(id, []);
      byLoc.get(id).push(a);
    }
  }
  const stats = new Map();
  for (const l of locs) {
    const here = byLoc.get(l.id) ?? [];
    const units = here.reduce((s, a) => s + stockOf(db, depotId, a.ean), 0);
    const alerts = here.filter((a) => isLow(levelOf(db, depotId, a).min, stockOf(db, depotId, a.ean))).length;
    const state = !here.length ? 'empty' : units === 0 ? 'zero' : alerts ? 'alert' : 'ok';
    stats.set(l.id, { loc: l, refs: here.length, units, alerts, state });
  }
  const byRack = new Map();
  for (const l of locs) {
    const rack = l.rack || '—';
    if (!byRack.has(rack)) byRack.set(rack, []);
    byRack.get(rack).push(l);
  }
  const racks = [...byRack.entries()].sort((a, b) => nat(a[0], b[0])).map(([name, list]) => {
    const colKey = (l) => [l.etagere, l.case].filter(Boolean).join('-') || '—';
    const columns = [...new Set(list.map(colKey))].sort(nat);
    const aisles = [...new Set(list.map((l) => l.allee || '—'))].sort(nat);
    const at = new Map();
    for (const l of list) { const k = `${l.allee || '—'}\u0000${colKey(l)}`; if (!at.has(k)) at.set(k, l); }
    const rows = aisles.map((aisle) => ({
      aisle,
      cells: columns.map((c) => {
        const l = at.get(`${aisle}\u0000${c}`);
        return l ? stats.get(l.id) : null;
      }),
    }));
    const cells = list.map((l) => stats.get(l.id));
    return { name, columns, rows, total: cells.length, occupied: cells.filter((c) => c.units > 0).length, alerts: cells.filter((c) => c.state === 'alert').length };
  });
  const all = [...stats.values()];
  return {
    racks,
    total: all.length,
    occupied: all.filter((c) => c.units > 0).length,
    alerts: all.filter((c) => c.state === 'alert').length,
    cellOf: (id) => stats.get(id),
  };
}

/** Articles présents à un emplacement, avec leur quantité. */
export function articlesAt(db, depotId, locId) {
  return Object.values(db.articles)
    .filter((a) => (a.locations?.[depotId] ?? []).includes(locId))
    .map((a) => ({ article: a, qty: stockOf(db, depotId, a.ean) }))
    .sort((x, y) => nat(x.article.name, y.article.name));
}

// ── Transferts ──
export const pendingIncoming = (db, depotId) => Object.values(db.transfers).filter((t) => t.status === 'pending' && t.toDepotId === depotId);
export const pendingOutgoing = (db, depotId) => Object.values(db.transfers).filter((t) => t.status === 'pending' && t.fromDepotId === depotId);

export function transferOverview(db, depotId, now = new Date()) {
  const mine = Object.values(db.transfers).filter((t) => t.fromDepotId === depotId || t.toDepotId === depotId);
  const byDate = (a, b) => b.date.localeCompare(a.date);
  const done = mine.filter((t) => t.status === 'done');
  const delays = done.filter((t) => t.receivedDate).map((t) => (new Date(t.receivedDate) - new Date(t.date)) / 3_600_000);
  return {
    incoming: pendingIncoming(db, depotId).sort(byDate),
    outgoing: pendingOutgoing(db, depotId).sort(byDate),
    past: mine.filter((t) => t.status !== 'pending').sort(byDate),
    avgDelayHours: delays.length ? Math.round(delays.reduce((a, b) => a + b, 0) / delays.length) : null,
    received30d: done.filter((t) => t.receivedDate && now - new Date(t.receivedDate) <= 30 * DAY).length,
  };
}

// ── Journaux ──
/** Mouvements filtrés (du plus récent au plus ancien). `depotId: null` = tous les dépôts. */
export function movements(db, { depotId = null, ean = '', types = null, q = '', since = 0, limit = 200 } = {}) {
  const out = [];
  for (const h of db.history) {
    if (depotId && h.depotId !== depotId) continue;
    if (ean && h.ean !== ean) continue;
    if (types && !types.includes(h.type)) continue;
    if (since && new Date(h.date).getTime() < since) continue;
    if (q && !matches(q, h.name, h.ean, h.operator, h.loc, h.reason, h.note)) continue;
    out.push(h);
    if (out.length >= limit) break;
  }
  return out;
}

export function auditEntries(db, { depotId = null, type = 'all', q = '', limit = 200 } = {}) {
  const out = [];
  for (const e of db.audit) {
    if (depotId && e.depotId !== depotId && e.type !== 'login') continue;
    if (type !== 'all' && e.type !== type) continue;
    if (q && !matches(q, e.action, e.operator, e.meta?.ean)) continue;
    out.push(e);
    if (out.length >= limit) break;
  }
  return out;
}

export function daysSince(iso, now = new Date()) {
  if (!iso) return Infinity;
  return Math.floor((now.getTime() - new Date(iso).getTime()) / DAY);
}
