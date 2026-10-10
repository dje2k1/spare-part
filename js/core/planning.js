// Planification (lecture seule) : seuils intelligents, prévisions de rupture, commandes, briefing du jour,
// rapport hebdomadaire. Fonctions pures (db, paramètres, now) → données.
import { stockOf, levelOf, incomingIndex, reorderList, articleLocations, isLow } from './queries.js';
import { weekOf } from './ops-kit.js';
import { matches, natCompare as nat } from '../lib/text.js';

const DAY = 86_400_000;
const days = (a, b) => (new Date(b).getTime() - new Date(a).getTime()) / DAY;

export const orderLabel = (o) => `${o.kind === 'supplier' ? 'ACH' : 'CMD'} ${o.no || '—'}`;
export const orderUnits = (o, key = 'qty') => o.lines.reduce((n, l) => n + (l[key] ?? 0), 0);

// ── Consommation et seuils intelligents ──
/** Quantile de la loi normale (niveau de service → coefficient de sécurité), interpolé. */
const Z_TABLE = [[50, 0], [60, 0.253], [70, 0.524], [75, 0.674], [80, 0.842], [85, 1.036], [90, 1.282], [92, 1.405], [95, 1.645], [97, 1.881], [98, 2.054], [99, 2.326]];
export function zFor(serviceLevel) {
  const s = Math.min(99, Math.max(50, Number(serviceLevel) || 95));
  for (let i = 1; i < Z_TABLE.length; i++) {
    const [s1, z1] = Z_TABLE[i - 1], [s2, z2] = Z_TABLE[i];
    if (s <= s2) return z1 + ((s - s1) / (s2 - s1)) * (z2 - z1);
  }
  return Z_TABLE.at(-1)[1];
}

/**
 * Consommation d'un article dans un dépôt sur les `weeks` dernières semaines complètes (+ semaine en cours).
 * Fenêtre raccourcie pour un article récent (au moins 4 semaines) : sa moyenne n'est pas diluée.
 */
export function usageStats(db, depotId, ean, now = new Date(), { weeks = 13 } = {}) {
  const map = db.usage?.[depotId]?.[ean] ?? {};
  const cur = weekOf(now);
  const keys = Object.keys(map).map(Number).filter((w) => w <= cur);
  const first = keys.length ? Math.min(...keys) : cur;
  const span = Math.max(4, Math.min(weeks, cur - first + 1));
  const series = [];
  for (let w = cur - span; w < cur; w++) series.push(map[w] ?? 0);
  const elapsed = ((new Date(now).getUTCDay() + 6) % 7) + 1; // jours écoulés dans la semaine en cours (1..7)
  const total = series.reduce((a, b) => a + b, 0) + (map[cur] ?? 0);
  const avgDaily = total / (span * 7 + elapsed);
  const mean = series.reduce((a, b) => a + b, 0) / series.length;
  const sdWeekly = Math.sqrt(series.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, series.length - 1));
  const activeWeeks = series.filter((x) => x > 0).length + ((map[cur] ?? 0) > 0 ? 1 : 0);
  const confidence = activeWeeks >= 6 ? 'high' : activeWeeks >= 3 ? 'medium' : activeWeeks >= 1 ? 'low' : 'none';
  return { avgDaily, sdDaily: sdWeekly / Math.sqrt(7), total, weeks: span, activeWeeks, confidence, series };
}

/** Délai moyen mesuré envoi → réception des commandes d'un atelier (10 dernières, au moins 3), en jours. */
export function measuredLeadDays(db, depotId) {
  const done = Object.values(db.orders).filter((o) => o.kind === 'internal' && o.depotId === depotId && o.status === 'received' && o.submittedAt && o.receivedAt)
    .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)).slice(0, 10);
  if (done.length < 3) return null;
  return Math.round((done.reduce((s, o) => s + days(o.submittedAt, o.receivedAt), 0) / done.length) * 10) / 10;
}

/**
 * Délai de réapprovisionnement d'un article dans un dépôt (jours). `measured` : délai mesuré de l'atelier
 * déjà calculé (undefined = à calculer) — évite de relire toutes les commandes pour chaque article.
 */
export function leadDaysFor(db, depot, article, measured) {
  const s = db.meta.settings;
  if (depot.kind === 'central') return db.suppliers[article.supplierId]?.leadDays ?? s.leadDaysSupplier;
  return (measured === undefined ? measuredLeadDays(db, depot.id) : measured) ?? s.leadDaysInternal;
}

const roundPack = (n, pack) => (pack > 1 ? Math.ceil(n / pack) * pack : n);

/**
 * Seuils proposés : point de commande = consommation pendant le délai + stock de sécurité
 * (z × écart-type journalier × √délai, z selon le niveau de service) ; maximum = point de commande
 * + N jours de couverture (réglage), arrondi au conditionnement. null si aucune consommation observée.
 * `measured` : voir leadDaysFor.
 */
export function proposeLevel(db, depot, article, now = new Date(), { measured } = {}) {
  const st = usageStats(db, depot.id, article.ean, now);
  if (st.confidence === 'none') return null;
  const s = db.meta.settings;
  const lead = leadDaysFor(db, depot, article, measured);
  const cover = depot.kind === 'central' ? s.coverDaysCentral : s.coverDaysAtelier;
  const safety = zFor(s.serviceLevel) * st.sdDaily * Math.sqrt(Math.max(1, lead));
  const min = Math.max(1, Math.ceil(st.avgDaily * lead + safety));
  const max = roundPack(Math.max(min + 1, Math.ceil(min + st.avgDaily * cover)), article.pack || 1);
  return { min, max, lead, safety: Math.round(safety * 10) / 10, avgDaily: st.avgDaily, confidence: st.confidence, stats: st };
}

export const daysLeft = (qty, avgDaily) => (avgDaily > 0 ? qty / avgDaily : Infinity);

/**
 * Tableau des seuils : actuel vs proposé pour chaque article consommé dans le dépôt.
 * `changedOnly` : seulement les écarts significatifs (≥ 20 % ou ≥ 2 unités).
 */
export function levelProposals(db, depotId, now = new Date(), { changedOnly = false, q = '' } = {}) {
  const depot = db.depots[depotId];
  if (!depot) return [];
  const rows = [];
  const measured = depot.kind === 'central' ? null : measuredLeadDays(db, depot.id);
  const used = db.usage?.[depotId] ?? {};
  for (const article of Object.values(db.articles)) {
    if (!used[article.ean]) continue; // jamais consommé ici : aucune proposition (voir proposeLevel)
    if (q && !matches(q, article.name, article.ean, article.family, article.ref)) continue;
    const proposed = proposeLevel(db, depot, article, now, { measured });
    if (!proposed) continue;
    const current = levelOf(db, depotId, article);
    const qty = stockOf(db, depotId, article.ean);
    const diff = Math.abs(proposed.min - current.min);
    const significant = current.min === 0 || diff >= 2 && diff / Math.max(1, current.min) >= 0.2;
    if (changedOnly && !significant) continue;
    rows.push({ article, current, proposed, qty, significant, daysLeft: daysLeft(qty, proposed.avgDaily), trend: proposed.min > current.min ? 'up' : proposed.min < current.min ? 'down' : 'same' });
  }
  return rows.sort((a, b) => Number(b.significant) - Number(a.significant) || a.daysLeft - b.daysLeft || nat(a.article.name, b.article.name));
}

/** Ruptures prévues sous `horizon` jours (en comptant ce qui est déjà en route). */
export function stockoutForecast(db, depotId, now = new Date(), { horizon = 7 } = {}) {
  const out = [];
  const route = incomingIndex(db, depotId);
  const used = db.usage?.[depotId] ?? {};
  for (const a of Object.values(db.articles)) {
    if (!used[a.ean]) continue; // aucune consommation enregistrée : pas de prévision
    const { avgDaily } = usageStats(db, depotId, a.ean, now);
    if (avgDaily <= 0) continue;
    const qty = stockOf(db, depotId, a.ean);
    const incoming = route.get(a.ean) ?? 0;
    const left = daysLeft(qty + incoming, avgDaily);
    if (left < horizon) out.push({ article: a, qty, incoming, avgDaily, daysLeft: left, date: new Date(new Date(now).getTime() + left * DAY) });
  }
  return out.sort((a, b) => a.daysLeft - b.daysLeft);
}

// ── Commandes ──
export const draftFor = (db, depotId) => Object.values(db.orders).find((o) => o.kind === 'internal' && o.status === 'draft' && o.depotId === depotId) ?? null;

const byDate = (key) => (a, b) => String(b[key] ?? b.createdAt).localeCompare(String(a[key] ?? a.createdAt));

/** Vue atelier : à réceptionner, en cours chez l'entrepôt, historique. */
export function atelierOrders(db, depotId) {
  const mine = Object.values(db.orders).filter((o) => o.kind === 'internal' && o.depotId === depotId && o.status !== 'draft');
  return {
    toReceive: mine.filter((o) => o.status === 'shipped').sort(byDate('shippedAt')),
    pending: mine.filter((o) => o.status === 'submitted' || o.status === 'picking').sort(byDate('submittedAt')),
    past: mine.filter((o) => ['received', 'cancelled'].includes(o.status)).sort(byDate('receivedAt')),
  };
}

/** Vue entrepôt central : commandes des ateliers à préparer (les plus anciennes d'abord), en préparation, expédiées. */
export function centralQueue(db, centralId) {
  const all = Object.values(db.orders).filter((o) => o.kind === 'internal' && o.sourceId === centralId && o.status !== 'draft');
  const oldest = (a, b) => String(a.submittedAt).localeCompare(String(b.submittedAt));
  return {
    toPrepare: all.filter((o) => o.status === 'submitted').sort(oldest),
    picking: all.filter((o) => o.status === 'picking').sort(oldest),
    shipped: all.filter((o) => o.status === 'shipped').sort(byDate('shippedAt')),
    past: all.filter((o) => ['received', 'cancelled'].includes(o.status)).sort(byDate('receivedAt')),
  };
}

/** Disponibilité à l'entrepôt pour préparer une commande (lignes en rupture signalées). */
export function pickList(db, order) {
  const central = db.depots[order.sourceId];
  return order.lines.map((l) => {
    const avail = central ? stockOf(db, central.id, l.ean) : 0;
    const locs = central ? articleLocations(db, l.ean, central.id) : [];
    return { ...l, avail, short: avail < l.qty, locs, loc: locs[0] ?? null };
  }).sort((a, b) => nat(a.loc ? [a.loc.rack, a.loc.allee, a.loc.etagere, a.loc.case].join('-') : '￿', b.loc ? [b.loc.rack, b.loc.allee, b.loc.etagere, b.loc.case].join('-') : '￿') || nat(a.name, b.name));
}

/** Commandes fournisseurs de l'entrepôt central. `late` : délai fournisseur dépassé. */
export function purchaseOverview(db, centralId, now = new Date()) {
  const all = Object.values(db.orders).filter((o) => o.kind === 'supplier' && o.depotId === centralId);
  const lead = (o) => db.suppliers[o.supplierId]?.leadDays ?? db.meta.settings.leadDaysSupplier;
  const open = all.filter((o) => o.status === 'sent' || o.status === 'partial').sort(byDate('sentAt'));
  return {
    drafts: all.filter((o) => o.status === 'draft').sort(byDate('createdAt')),
    open,
    late: open.filter((o) => o.sentAt && days(o.sentAt, now) > lead(o)),
    past: all.filter((o) => ['received', 'closed', 'cancelled'].includes(o.status)).sort(byDate('receivedAt')),
  };
}

/** Réassort de l'entrepôt regroupé par fournisseur (prêt à transformer en commandes fournisseurs). */
export function purchaseSuggestions(db, centralId) {
  const groups = new Map();
  for (const r of reorderList(db, centralId)) {
    const key = r.article.supplierId && db.suppliers[r.article.supplierId] ? r.article.supplierId : '';
    if (!groups.has(key)) groups.set(key, { supplier: db.suppliers[key] ?? null, rows: [], cost: 0 });
    const g = groups.get(key);
    g.rows.push(r);
    g.cost += r.cost;
  }
  return [...groups.values()].sort((a, b) => (a.supplier ? 0 : 1) - (b.supplier ? 0 : 1) || nat(a.supplier?.name, b.supplier?.name));
}

// ── Briefing du jour (A12) ──
/**
 * « Votre journée » : ce qui demande une action aujourd'hui, selon le dépôt et le rôle.
 * Chaque élément : { key, tone, icon, title, text, to, count }. Les plus urgents d'abord.
 */
export function briefing(db, { depotId, role, now = new Date() }) {
  const depot = db.depots[depotId];
  if (!depot) return [];
  const manager = role === 'manager' || role === 'admin';
  const items = [];
  const add = (it) => { if (it.count) items.push(it); };
  const ago = (iso) => Math.max(0, Math.floor(days(iso, now)));

  if (depot.kind === 'central') {
    const q = centralQueue(db, depot.id);
    const oldest = q.toPrepare[0];
    add({ key: 'prepare', tone: 'info', icon: 'box', to: 'orders', count: q.toPrepare.length, title: `${q.toPrepare.length} commande${q.toPrepare.length > 1 ? 's' : ''} à préparer`, text: oldest ? `La plus ancienne : ${db.depots[oldest.depotId]?.name ?? '—'}, il y a ${ago(oldest.submittedAt)} j` : '' });
    add({ key: 'picking', tone: 'info', icon: 'clipboard', to: 'orders', count: q.picking.length, title: `${q.picking.length} en préparation`, text: [...new Set(q.picking.map((o) => o.pickedBy))].join(', ') });
    // Demande cumulée de toutes les commandes à servir : deux commandes de 5 face à un stock de 8 = pièce manquante
    const need = new Map();
    for (const o of q.toPrepare.concat(q.picking)) for (const l of o.lines) need.set(l.ean, (need.get(l.ean) ?? 0) + l.qty);
    const short = [...need].filter(([ean, n]) => stockOf(db, depot.id, ean) < n).length;
    add({ key: 'shortage', tone: 'low', icon: 'alert', to: 'orders', count: short, title: `${short} pièce(s) manquante(s) pour servir les ateliers`, text: 'Demande des commandes en attente supérieure au stock' });
    if (manager) {
      const p = purchaseOverview(db, depot.id, now);
      add({ key: 'late', tone: 'low', icon: 'clock', to: 'purchases', count: p.late.length, title: `${p.late.length} commande(s) fournisseur en retard`, text: p.late.slice(0, 2).map((o) => db.suppliers[o.supplierId]?.name).join(', ') });
      add({ key: 'expected', tone: 'info', icon: 'truck', to: 'purchases', count: p.open.length - p.late.length, title: `${p.open.length - p.late.length} livraison(s) fournisseur attendue(s)`, text: '' });
      const sugg = reorderList(db, depot.id).length;
      add({ key: 'buy', tone: 'gold', icon: 'cart', to: 'purchases', count: sugg, title: `${sugg} article(s) à commander aux fournisseurs`, text: 'Préparer les commandes fournisseurs' });
    }
  } else {
    const o = atelierOrders(db, depot.id);
    add({ key: 'receive', tone: 'info', icon: 'truck', to: 'orders', count: o.toReceive.length, title: `${o.toReceive.length} livraison${o.toReceive.length > 1 ? 's' : ''} à réceptionner`, text: o.toReceive.slice(0, 2).map((x) => `${orderLabel(x)} · ${orderUnits(x, 'shipped')} pièce(s)`).join(', ') });
    const refused = o.past.filter((x) => x.status === 'cancelled' && x.reason && days(x.cancelledAt, now) <= 2);
    add({ key: 'refused', tone: 'low', icon: 'alert', to: 'orders', count: refused.length, title: `${refused.length} commande(s) refusée(s) par l'entrepôt`, text: refused[0]?.reason ?? '' });
    const toOrder = reorderList(db, depot.id, { withDraft: true }).length;
    add({ key: 'order', tone: 'gold', icon: 'cart', to: 'order', count: toOrder, title: `${toOrder} pièce${toOrder > 1 ? 's' : ''} à commander`, text: 'Sous le seuil, rien en route' });
  }
  const transfers = Object.values(db.transfers).filter((t) => t.status === 'pending' && t.toDepotId === depot.id).length;
  add({ key: 'transfers', tone: 'info', icon: 'swap', to: 'transfers', count: transfers, title: `${transfers} transfert(s) à réceptionner`, text: '' });
  const zeros = Object.values(db.articles).filter((a) => levelOf(db, depot.id, a).min > 0 && stockOf(db, depot.id, a.ean) === 0).length;
  add({ key: 'zero', tone: 'low', icon: 'alert', to: 'articles?f=zero', count: zeros, title: `${zeros} pièce${zeros > 1 ? 's' : ''} en rupture`, text: '' });
  const soon = stockoutForecast(db, depot.id, now, { horizon: 7 }).filter((r) => r.qty > 0);
  add({ key: 'soon', tone: 'low', icon: 'clock', to: manager ? 'levels' : 'articles?f=alert', count: soon.length, title: `${soon.length} rupture${soon.length > 1 ? 's' : ''} prévue${soon.length > 1 ? 's' : ''} sous 7 jours`, text: soon.slice(0, 2).map((r) => r.article.name).join(', ') });
  if (manager) {
    const since = new Date(now).getTime() - 7 * DAY;
    const gaps = Object.values(db.orders).filter((x) => x.kind === 'internal' && x.gaps > 0 && x.receivedAt && new Date(x.receivedAt).getTime() >= since && (x.depotId === depot.id || x.sourceId === depot.id));
    add({ key: 'gaps', tone: 'low', icon: 'alert', to: 'orders', count: gaps.length, title: `${gaps.length} réception(s) avec écart cette semaine`, text: gaps.slice(0, 2).map(orderLabel).join(', ') });
    const review = levelProposals(db, depot.id, now, { changedOnly: true }).length;
    add({ key: 'levels', tone: 'gold', icon: 'chart', to: 'levels', count: review, title: `${review} seuil${review > 1 ? 's' : ''} à revoir`, text: 'Selon la consommation réelle' });
  }
  const rank = { low: 0, info: 1, gold: 2 };
  return items.sort((a, b) => rank[a.tone] - rank[b.tone]);
}

// ── Rapport hebdomadaire ──
export function weeklyReport(db, depotId, now = new Date(), { days: span = 7 } = {}) {
  const depot = db.depots[depotId];
  const since = new Date(now).getTime() - span * DAY;
  const inRange = (iso) => iso && new Date(iso).getTime() >= since && new Date(iso).getTime() <= new Date(now).getTime();
  const moves = db.history.filter((h) => h.depotId === depotId && inRange(h.date) && !h.undone && !h.undoOf);
  const sum = (arr, f) => arr.reduce((s, x) => s + f(x), 0);
  const price = (ean) => db.articles[ean]?.price || 0;
  const consumed = new Map();
  for (const h of moves) {
    if (h.type !== 'out' && h.type !== 'transfer') continue;
    const e = consumed.get(h.ean) ?? { ean: h.ean, name: db.articles[h.ean]?.name ?? h.name, units: 0, value: 0 };
    e.units += h.qty; e.value += h.qty * price(h.ean);
    consumed.set(h.ean, e);
  }
  const top = [...consumed.values()].sort((a, b) => b.units - a.units).slice(0, 10);
  const internal = Object.values(db.orders).filter((o) => o.kind === 'internal' && (o.depotId === depotId || o.sourceId === depotId));
  const shipped = internal.filter((o) => inRange(o.shippedAt));
  const received = internal.filter((o) => inRange(o.receivedAt) && o.status === 'received');
  const requested = sum(shipped, (o) => orderUnits(o, 'qty'));
  const served = sum(shipped, (o) => orderUnits(o, 'shipped'));
  const lead = received.filter((o) => o.submittedAt).map((o) => days(o.submittedAt, o.receivedAt));
  let value = 0, alerts = 0, zeros = 0;
  for (const a of Object.values(db.articles)) {
    const q = stockOf(db, depotId, a.ean);
    value += q * (a.price || 0);
    const { min } = levelOf(db, depotId, a);
    if (isLow(min, q)) alerts++;
    if (min > 0 && q === 0) zeros++;
  }
  const perAtelier = depot?.kind === 'central'
    ? Object.values(db.depots).filter((d) => d.kind !== 'central').map((d) => {
      const os = shipped.filter((o) => o.depotId === d.id);
      return { depot: d, orders: os.length, units: sum(os, (o) => orderUnits(o, 'shipped')) };
    }).filter((x) => x.orders)
    : [];
  return {
    depot, from: new Date(since), to: new Date(now), span,
    outUnits: sum(moves.filter((h) => h.type === 'out' || h.type === 'transfer'), (h) => h.qty),
    outValue: sum(moves.filter((h) => h.type === 'out' || h.type === 'transfer'), (h) => h.qty * price(h.ean)),
    inUnits: sum(moves.filter((h) => h.type === 'in' || h.type === 'transfer_in'), (h) => h.qty),
    corrections: moves.filter((h) => h.type === 'inv').length,
    top,
    orders: { shipped: shipped.length, received: received.length, serviceRate: requested ? Math.round((served / requested) * 100) : null, avgLeadDays: lead.length ? Math.round((sum(lead, (x) => x) / lead.length) * 10) / 10 : null, gaps: received.filter((o) => o.gaps > 0).length },
    stock: { value, alerts, zeros },
    perAtelier,
  };
}

