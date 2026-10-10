// Données de démonstration et création d'une installation vide.
//
// La démo n'est PAS écrite à la main : elle est produite en simulant ~16 semaines d'activité avec les
// vraies opérations métier (consommations, commandes des ateliers, préparation et expédition par
// l'entrepôt central, réceptions, commandes fournisseurs). Elle est donc cohérente par construction :
// stocks, historique, consommation (seuils intelligents), délais mesurés, commandes dans tous les états.
import { emptyDb } from './schema.js';
import { hashPin } from './auth.js';
import { LIMITS } from './config.js';
import { checkDigit } from '../lib/ean.js';
import { uid } from '../lib/id.js';
import { stockOf, reorderList } from './queries.js';
import { purchaseSuggestions, levelProposals } from './planning.js';
import { moveStock, createTransfer, receiveTransfer, cancelTransfer, recordAuth } from './ops.js';
import { setDraftLines, submitOrder, claimOrder, releaseOrder, shipOrder, receiveOrder, savePurchaseDraft, sendPurchase, receivePurchase, setLevels } from './ops-orders.js';

const DAY = 86_400_000;

/** PRNG déterministe (mulberry32) : même démo à chaque installation. */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const eanOf = (body) => body + checkDigit(body);

const SUPPLIERS = [
  ['cuirs', 'Cuirs & Sangles', 'commandes@cuirs-sangles.example', 21],
  ['boutons', 'Boutons Mercier', 'pro@boutons-mercier.example', 7],
  ['ykk', 'YKK France', 'adv@ykk.example', 10],
  ['laiton', 'Maison Laiton', 'contact@maison-laiton.example', 14],
];

// [désignation, famille, référence, prix, seuil, corps EAN, fournisseur, conditionnement, consommation/jour/atelier]
const CATALOGUE = [
  ['Bandoulière cuir naturel 120cm', 'Bandoulières', 'BND-CN-120', 18.5, 15, '370008969001', 'cuirs', 1, 1.6],
  ['Bandoulière chaîne dorée 110cm', 'Bandoulières', 'BND-CD-110', 24, 10, '370008969002', 'cuirs', 1, 0.9],
  ['Bandoulière tressée havane 100cm', 'Bandoulières', 'BND-TH-100', 21, 8, '370008969003', 'cuirs', 1, 0.6],
  ['Bouton métal doré Ø18mm', 'Boutons', 'BTN-MD-18', 1.2, 30, '400638133390', 'boutons', 10, 4],
  ['Bouton nacre Ø12mm', 'Boutons', 'BTN-NC-12', 0.9, 50, '400638133391', 'boutons', 10, 5],
  ['Bouton corne Ø22mm', 'Boutons', 'BTN-CO-22', 2.4, 25, '400638133392', 'boutons', 10, 2.5],
  ['Bouton logo CD argenté Ø15mm', 'Boutons', 'BTN-CD-15', 3.8, 20, '400638133393', 'boutons', 10, 1.8],
  ['Zip YKK 20cm – Noir', 'Zips', 'ZIP-YKK-20N', 1.6, 20, '570699805100', 'ykk', 10, 2.2],
  ['Zip YKK 30cm – Camel', 'Zips', 'ZIP-YKK-30C', 1.9, 15, '570699805101', 'ykk', 10, 1.5],
  ['Zip invisible 40cm – Beige', 'Zips', 'ZIP-INV-40B', 2.1, 12, '570699805102', 'ykk', 10, 1],
  ['Zip métal laiton 25cm', 'Zips', 'ZIP-ML-25', 3.4, 10, '570699805103', 'ykk', 5, 0.8],
  ['Fermoir clip laiton 25mm', 'Fermoirs', 'FRM-CL-25', 4.2, 10, '871210045000', 'laiton', 1, 0.9],
  ['Fermoir tournette argent 18mm', 'Fermoirs', 'FRM-TO-18', 5.6, 8, '871210045001', 'laiton', 1, 0.5],
  ['Fermoir magnétique plat 20mm', 'Fermoirs', 'FRM-MP-20', 3.1, 12, '871210045002', 'laiton', 1, 1.1],
  ['Boucle réglable laiton 35mm', 'Fermoirs', 'FRM-BR-35', 2.8, 15, '871210045003', 'laiton', 5, 1.3],
  ['Anneau D métal doré 20mm', 'Accessoires', 'ANN-DM-20', 0.85, 40, '376017019280', 'laiton', 20, 3.5],
  ['Œillet pression Ø10mm – Or', 'Accessoires', 'OEL-PR-10', 0.6, 50, '376017019281', 'laiton', 50, 4.5],
];

const ZONES = { Bandoulières: ['R1', 'A1'], Boutons: ['R1', 'A2'], Zips: ['R1', 'A3'], Fermoirs: ['R2', 'A1'], Accessoires: ['R2', 'A2'] };

const DEPOTS = [
  { key: 'central', name: 'Entrepôt central', location: 'Orly', code: 'CEN', kind: 'central', activity: 0 },
  { key: 'paris', name: 'Atelier Paris – Maroquinerie', location: 'Paris, 8e', code: 'DEP-01', kind: 'atelier', activity: 1 },
  { key: 'lyon', name: 'Atelier Lyon – Sellerie', location: 'Lyon, 6e', code: 'DEP-02', kind: 'atelier', activity: 0.8 },
  { key: 'nice', name: 'Atelier Nice – Couture', location: 'Nice, Vieux', code: 'DEP-03', kind: 'atelier', activity: 0.6 },
];

// [nom, rôle, dépôt, PIN]
const USERS = [
  ['Administrateur', 'admin', 'paris', '1234'],
  ['Sophie Martin', 'manager', 'paris', '2345'],
  ['Marc Dubois', 'manager', 'lyon', '3456'],
  ['Julie Laurent', 'operator', 'paris', '4567'],
  ['Pierre Blanc', 'operator', 'nice', '5678'],
  ['Karim Benali', 'manager', 'central', '2468'],
  ['Léa Moreau', 'operator', 'central', '1357'],
];

const SIM_DAYS = 112;

/**
 * Base de démonstration : entrepôt central + 3 ateliers, 17 articles, 4 fournisseurs, 7 utilisateurs,
 * ~16 semaines d'activité simulée.
 * @param {Date} now
 * @param {{pinIterations?: number}} [opt] itérations PBKDF2 (réduites dans les tests)
 */
export async function buildDemoDb(now = new Date(), { pinIterations } = {}) {
  const rnd = prng(20260101);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
  const start = new Date(now.getTime() - SIM_DAYS * DAY);
  const db = emptyDb(start);
  db.meta.demo = true;

  const depots = {};
  for (const d of DEPOTS) {
    const id = uid(start.getTime());
    depots[d.key] = db.depots[id] = { id, name: d.name, location: d.location, code: d.code, kind: d.kind };
    db.stocks[id] = {};
  }
  const hashed = await Promise.all(USERS.map(([, , , pin]) => hashPin(pin, pinIterations ? { iter: pinIterations } : undefined)));
  const users = {};
  USERS.forEach(([name, role, dk], i) => {
    const id = uid(start.getTime());
    users[name] = db.users[id] = { id, name, role, depotId: depots[dk].id, pin: hashed[i] };
  });
  db.meta.demoPins = USERS.map(([name, , , pin]) => ({ name, pin }));

  const suppliers = {};
  for (const [key, name, email, leadDays] of SUPPLIERS) {
    const id = uid(start.getTime());
    suppliers[key] = db.suppliers[id] = { id, name, email, phone: '', note: '', leadDays };
  }
  const rate = {};
  const arts = CATALOGUE.map(([name, family, ref, price, threshold, body, sup, pack, perDay]) => {
    const ean = eanOf(body);
    db.articles[ean] = { ean, name, family, ref, price, threshold, photo: '', supplierId: suppliers[sup].id, supplierRef: `${sup.toUpperCase()}-${ref}`, pack, locations: {} };
    rate[ean] = perDay;
    return db.articles[ean];
  });

  // Emplacements : 2 racks × 3 allées × 2 étagères par dépôt ; chaque pièce rangée selon sa famille
  for (const d of Object.values(depots)) {
    for (const rack of ['R1', 'R2']) for (const allee of ['A1', 'A2', 'A3']) for (const etagere of ['E1', 'E2']) {
      const id = uid(start.getTime());
      const family = Object.entries(ZONES).find(([, z]) => z[0] === rack && z[1] === allee)?.[0];
      db.locations[id] = { id, depotId: d.id, rack, allee, etagere, case: 'C1', desc: family ? `${family} — étagère ${etagere.slice(1)}` : 'Réserve' };
    }
    const famIdx = {};
    for (const a of arts) {
      const [rack, allee] = ZONES[a.family];
      const k = (famIdx[a.family] = (famIdx[a.family] ?? -1) + 1);
      a.locations[d.id] = [Object.values(db.locations).find((l) => l.depotId === d.id && l.rack === rack && l.allee === allee && l.etagere === (k % 2 === 0 ? 'E1' : 'E2')).id];
    }
  }
  // Stock initial ; l'entrepôt sert trois ateliers : ses seuils de départ sont dimensionnés en conséquence
  // (ils seront ensuite recalculés sur la consommation réelle, comme le ferait un responsable).
  for (const a of arts) {
    for (const d of Object.values(depots)) db.stocks[d.id][a.ean] = d.kind === 'central' ? a.threshold * 16 : a.threshold * 3;
    (db.levels[depots.central.id] ??= {})[a.ean] = { min: a.threshold * 6, max: a.threshold * 14 };
  }

  // ── Simulation jour par jour ──
  const limits = { history: 1e6, audit: 1e6 };
  const ctxFor = (user, depot, at) => ({ user: { id: user.id, name: user.name, role: user.role, depotId: user.depotId }, depotId: depot.id, now: at, limits });
  // Horloge de simulation strictement croissante : l'ordre des dates = l'ordre d'exécution (historique cohérent).
  let clock = start.getTime();
  const openDay = (day) => {
    const d = new Date(start.getTime() + day * DAY);
    d.setHours(7, 0, 0, 0);
    clock = Math.max(clock, day === SIM_DAYS ? Math.min(d.getTime(), now.getTime() - 4 * 3600_000) : d.getTime());
  };
  const tick = (day) => {
    clock += (day === SIM_DAYS ? int(1, 3) : int(2, 9)) * 60_000 + int(0, 59) * 1000;
    return new Date(Math.min(clock, now.getTime() - 1000));
  };
  const tryOp = (fn) => { try { return fn(); } catch (e) { if (e?.isOpError) return null; throw e; } };
  const staffOf = { paris: [users['Julie Laurent'], users['Sophie Martin']], lyon: [users['Marc Dubois']], nice: [users['Pierre Blanc']] };
  const ateliers = DEPOTS.filter((d) => d.kind === 'atelier');
  const central = depots.central;
  const karim = users['Karim Benali'], lea = users['Léa Moreau'];
  const reasons = ['Production', 'Production', 'Production', 'Réparation client', 'Casse / rebut', 'Échantillon'];

  for (let day = 0; day <= SIM_DAYS; day++) {
    const date = new Date(start.getTime() + day * DAY);
    const dow = date.getDay();
    if (dow === 0 && day !== SIM_DAYS) continue; // dimanche
    const last = day === SIM_DAYS;
    openDay(day);
    // Situation du jour, riche pour la démonstration : Lyon et Nice envoient leur commande ce matin
    if (last) {
      for (const [key, user] of [['lyon', users['Marc Dubois']], ['nice', users['Pierre Blanc']]]) {
        const c = ctxFor(user, depots[key], tick(day));
        const lines = arts.slice(3, 9).map((a) => ({ ean: a.ean, qty: roundTo(int(10, 40), a.pack) }));
        const r = tryOp(() => setDraftLines(db, c, { lines }));
        if (r?.orderId) tryOp(() => submitOrder(db, c, { id: r.orderId }));
      }
    }

    // Connexions du matin (journal d'audit)
    if (day % 9 === 0) for (const u of Object.values(users)) recordAuth(db, ctxFor(u, db.depots[u.depotId], tick(day)), { kind: 'login' });

    // 1. L'entrepôt réceptionne les livraisons fournisseurs arrivées
    for (const o of Object.values(db.orders).filter((x) => x.kind === 'supplier' && (x.status === 'sent' || x.status === 'partial'))) {
      const due = new Date(o.sentAt).getTime() + (db.suppliers[o.supplierId].leadDays + int(-1, 2)) * DAY;
      if (date.getTime() < due || (last && rnd() < 0.5)) continue;
      const partial = o.status === 'sent' && rnd() < 0.15;
      const lines = o.lines.map((l) => ({ ean: l.ean, qty: partial ? Math.floor((l.qty - (l.received ?? 0)) / 2) : l.qty - (l.received ?? 0) })).filter((l) => l.qty > 0);
      if (lines.length) tryOp(() => receivePurchase(db, ctxFor(lea, central, tick(day)), { id: o.id, lines }));
    }
    // 2. L'entrepôt prépare et expédie les commandes envoyées la veille (ou avant)
    for (const o of Object.values(db.orders).filter((x) => x.kind === 'internal' && x.status === 'submitted').sort((a, b) => a.submittedAt.localeCompare(b.submittedAt))) {
      if (date.getTime() - new Date(o.submittedAt).getTime() < (last ? 2 : 0.6) * DAY) continue;
      const c = ctxFor(rnd() < 0.7 ? lea : karim, central, tick(day));
      tryOp(() => claimOrder(db, c, { id: o.id }));
      const lines = o.lines.map((l) => ({ ean: l.ean, qty: Math.min(l.qty, stockOf(db, central.id, l.ean)) }));
      if (!tryOp(() => shipOrder(db, { ...c, now: tick(day) }, { id: o.id, lines }))) tryOp(() => releaseOrder(db, c, { id: o.id }));
    }
    // 3. Les ateliers réceptionnent ce qui a été expédié (1 à 2 jours de transport)
    for (const o of Object.values(db.orders).filter((x) => x.kind === 'internal' && x.status === 'shipped')) {
      if (date.getTime() - new Date(o.shippedAt).getTime() < (last ? 3 : 1 + rnd()) * DAY) continue;
      const key = DEPOTS.find((d) => depots[d.key].id === o.depotId).key;
      const gap = rnd() < 0.08;
      const lines = o.lines.map((l, i) => ({ ean: l.ean, qty: gap && i === 0 ? Math.max(0, (l.shipped ?? 0) - 1) : l.shipped ?? 0 }));
      tryOp(() => receiveOrder(db, ctxFor(pick(staffOf[key]), depots[key], tick(day)), { id: o.id, lines }));
    }
    // 4. Consommation des ateliers (le gros de l'activité)
    for (const d of ateliers) {
      const depot = depots[d.key];
      for (const a of arts) {
        const mean = rate[a.ean] * d.activity * (dow === 6 ? 0.4 : 1);
        let qty = 0;
        for (let k = 0; k < 4; k++) qty += rnd() < mean / 4 ? 1 + Math.floor(rnd() * 1.6) : 0;
        if (!qty) continue;
        qty = Math.min(qty, stockOf(db, depot.id, a.ean));
        if (qty > 0) tryOp(() => moveStock(db, ctxFor(pick(staffOf[d.key]), depot, tick(day)), { type: 'out', ean: a.ean, qty, reason: pick(reasons) }));
      }
    }
    // 5. Commandes des ateliers (lundi et jeudi) : le réassort suggéré devient une commande
    if ((dow === 1 || dow === 4) && !last) {
      for (const d of ateliers) {
        const depot = depots[d.key];
        const c = ctxFor(pick(staffOf[d.key]), depot, tick(day));
        const lines = reorderList(db, depot.id, { withDraft: true }).map((r) => ({ ean: r.article.ean, qty: r.suggested }));
        if (!lines.length) continue;
        const draft = tryOp(() => setDraftLines(db, c, { lines }));
        if (draft?.orderId) tryOp(() => submitOrder(db, c, { id: draft.orderId }));
      }
    }
    // 6. Commandes fournisseurs de l'entrepôt (le lundi)
    if (dow === 1 && !last) {
      for (const g of purchaseSuggestions(db, central.id)) {
        if (!g.supplier) continue;
        const c = ctxFor(karim, central, tick(day));
        const r = tryOp(() => savePurchaseDraft(db, c, { supplierId: g.supplier.id, lines: g.rows.map((x) => ({ ean: x.article.ean, qty: x.suggested })) }));
        if (r) tryOp(() => sendPurchase(db, c, { id: r.orderId }));
      }
    }
    // 7. Toutes les 4 semaines, chaque responsable applique les seuils proposés (consommation réelle)
    if (day >= 35 && day % 28 === 7 && day < SIM_DAYS - 14) {
      for (const d of DEPOTS) {
        const depot = depots[d.key];
        const who = { central: karim, paris: users['Sophie Martin'], lyon: users['Marc Dubois'], nice: users.Administrateur }[d.key];
        const items = levelProposals(db, depot.id, date).map((r) => ({ ean: r.article.ean, min: r.proposed.min, max: r.proposed.max }));
        if (items.length) tryOp(() => setLevels(db, ctxFor(who, depot, tick(day)), { depotId: depot.id, items }));
      }
    }
    // Avant-veille : Paris commande (expédiée la veille par l'étape 2, à réceptionner aujourd'hui)
    if (day === SIM_DAYS - 2) {
      const c = ctxFor(users['Sophie Martin'], depots.paris, tick(day));
      const r = tryOp(() => setDraftLines(db, c, { lines: [{ ean: arts[4].ean, qty: 60 }, { ean: arts[7].ean, qty: 30 }, { ean: arts[15].ean, qty: 40 }] }));
      if (r?.orderId) tryOp(() => submitOrder(db, c, { id: r.orderId }));
    }
    // Veille : Lyon envoie quelques pièces à Paris (transfert à réceptionner)
    if (day === SIM_DAYS - 1) {
      const a = [...arts].sort((x, y) => stockOf(db, depots.lyon.id, y.ean) - stockOf(db, depots.lyon.id, x.ean))[0];
      tryOp(() => createTransfer(db, ctxFor(users['Marc Dubois'], depots.lyon, tick(day)), { ean: a.ean, qty: 8, toDepotId: depots.paris.id }));
    }
    // 8. Quelques transferts entre ateliers
    if (day % 11 === 5) {
      const [from, to] = [pick(ateliers), pick(ateliers)];
      if (from.key !== to.key) {
        const a = pick(arts);
        const r = tryOp(() => createTransfer(db, ctxFor(pick(staffOf[from.key]), depots[from.key], tick(day)), { ean: a.ean, qty: int(2, 6), toDepotId: depots[to.key].id }));
        if (r && day < SIM_DAYS - 3) {
          if (rnd() < 0.85) tryOp(() => receiveTransfer(db, ctxFor(pick(staffOf[to.key]), depots[to.key], tick(day + 1)), { id: r.transferId }));
          else tryOp(() => cancelTransfer(db, ctxFor(pick(staffOf[from.key]), depots[from.key], tick(day + 1)), { id: r.transferId }));
        }
      }
    }
  }

  // Journaux élagués comme sur un appareil
  if (db.history.length > LIMITS.history) db.history.length = LIMITS.history;
  if (db.audit.length > LIMITS.audit) db.audit.length = LIMITS.audit;
  db.meta.createdAt = new Date(now.getTime() - (SIM_DAYS + 1) * DAY).toISOString();
  return db;
}

const roundTo = (n, pack) => (pack > 1 ? Math.max(pack, Math.round(n / pack) * pack) : n);

/** Installation vide : un dépôt et un administrateur choisis par l'utilisateur. */
export async function buildFreshDb(now = new Date(), { adminName, pin, depotName, depotCode = '', depotLocation = '', depotKind = 'atelier', pinIterations } = {}) {
  const db = emptyDb(now);
  const depotId = uid(now.getTime());
  db.depots[depotId] = { id: depotId, name: depotName, location: depotLocation, code: String(depotCode).toUpperCase().slice(0, 10), kind: depotKind === 'central' ? 'central' : 'atelier' };
  db.stocks[depotId] = {};
  const id = uid(now.getTime());
  db.users[id] = { id, name: adminName, role: 'admin', depotId, pin: await hashPin(pin, pinIterations ? { iter: pinIterations } : undefined) };
  return db;
}
