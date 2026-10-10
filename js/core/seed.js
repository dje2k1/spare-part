// Données de démonstration (relatives à la date du jour) et création d'une installation vide.
// Le stock COURANT est tiré au sort ; l'historique est reconstruit en remontant le temps, ce qui
// garantit la cohérence (jamais de stock négatif, courbe d'évolution plausible).
import { emptyDb } from './schema.js';
import { hashPin } from './auth.js';
import { checkDigit } from '../lib/ean.js';
import { uid } from '../lib/id.js';

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

// [désignation, famille, référence, prix, seuil, corps EAN (12 chiffres)]
const CATALOGUE = [
  ['Bandoulière cuir naturel 120cm', 'Bandoulières', 'BND-CN-120', 18.5, 15, '370008969001'],
  ['Bandoulière chaîne dorée 110cm', 'Bandoulières', 'BND-CD-110', 24, 10, '370008969002'],
  ['Bandoulière tressée havane 100cm', 'Bandoulières', 'BND-TH-100', 21, 8, '370008969003'],
  ['Bouton métal doré Ø18mm', 'Boutons', 'BTN-MD-18', 1.2, 30, '400638133390'],
  ['Bouton nacre Ø12mm', 'Boutons', 'BTN-NC-12', 0.9, 50, '400638133391'],
  ['Bouton corne Ø22mm', 'Boutons', 'BTN-CO-22', 2.4, 25, '400638133392'],
  ['Bouton logo CD argenté Ø15mm', 'Boutons', 'BTN-CD-15', 3.8, 20, '400638133393'],
  ['Zip YKK 20cm – Noir', 'Zips', 'ZIP-YKK-20N', 1.6, 20, '570699805100'],
  ['Zip YKK 30cm – Camel', 'Zips', 'ZIP-YKK-30C', 1.9, 15, '570699805101'],
  ['Zip invisible 40cm – Beige', 'Zips', 'ZIP-INV-40B', 2.1, 12, '570699805102'],
  ['Zip métal laiton 25cm', 'Zips', 'ZIP-ML-25', 3.4, 10, '570699805103'],
  ['Fermoir clip laiton 25mm', 'Fermoirs', 'FRM-CL-25', 4.2, 10, '871210045000'],
  ['Fermoir tournette argent 18mm', 'Fermoirs', 'FRM-TO-18', 5.6, 8, '871210045001'],
  ['Fermoir magnétique plat 20mm', 'Fermoirs', 'FRM-MP-20', 3.1, 12, '871210045002'],
  ['Boucle réglable laiton 35mm', 'Fermoirs', 'FRM-BR-35', 2.8, 15, '871210045003'],
  ['Anneau D métal doré 20mm', 'Accessoires', 'ANN-DM-20', 0.85, 40, '376017019280'],
  ['Œillet pression Ø10mm – Or', 'Accessoires', 'OEL-PR-10', 0.6, 50, '376017019281'],
];

const ZONES = { Bandoulières: ['R1', 'A1'], Boutons: ['R1', 'A2'], Zips: ['R1', 'A3'], Fermoirs: ['R2', 'A1'], Accessoires: ['R2', 'A2'] };

const DEPOTS = [
  { name: 'Atelier Paris – Maroquinerie', location: 'Paris, 8e', code: 'DEP-01' },
  { name: 'Atelier Lyon – Sellerie', location: 'Lyon, 6e', code: 'DEP-02' },
  { name: 'Atelier Nice – Couture', location: 'Nice, Vieux', code: 'DEP-03' },
];

const USERS = [
  ['Administrateur', 'admin', 0, '1234'],
  ['Sophie Martin', 'manager', 0, '2345'],
  ['Marc Dubois', 'manager', 1, '3456'],
  ['Julie Laurent', 'operator', 0, '4567'],
  ['Pierre Blanc', 'operator', 2, '5678'],
];

/**
 * Base de démonstration : 3 dépôts, 17 articles, 5 utilisateurs, ~45 jours d'activité, 4 transferts.
 * @param {Date} now
 * @param {{pinIterations?: number}} [opt] itérations PBKDF2 (réduites dans les tests)
 */
export async function buildDemoDb(now = new Date(), { pinIterations } = {}) {
  const rnd = prng(20260101);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
  const db = emptyDb(now);
  db.meta.demo = true;

  // Dépôts
  const depots = DEPOTS.map((d) => { const id = uid(now.getTime()); db.depots[id] = { id, ...d }; db.stocks[id] = {}; return db.depots[id]; });

  // Utilisateurs (PIN hachés)
  const hashed = await Promise.all(USERS.map(([, , , pin]) => hashPin(pin, pinIterations ? { iter: pinIterations } : undefined)));
  USERS.forEach(([name, role, di], i) => {
    const id = uid(now.getTime());
    db.users[id] = { id, name, role, depotId: depots[di].id, pin: hashed[i] };
  });
  db.meta.demoPins = USERS.map(([name, , , pin]) => ({ name, pin }));
  const staff = (depotId) => Object.values(db.users).filter((u) => u.depotId === depotId || u.role === 'admin');

  // Catalogue
  const perFamily = {};
  const arts = CATALOGUE.map(([name, family, ref, price, threshold, body]) => {
    const ean = eanOf(body);
    db.articles[ean] = { ean, name, family, ref, price, threshold, photo: '', locations: {} };
    perFamily[family] = (perFamily[family] ?? 0) + 1;
    return db.articles[ean];
  });

  // Emplacements : 2 racks × 3 allées × 2 étagères par dépôt
  for (const d of depots) {
    for (const rack of ['R1', 'R2']) for (const allee of ['A1', 'A2', 'A3']) for (const etagere of ['E1', 'E2']) {
      const id = uid(now.getTime());
      const family = Object.entries(ZONES).find(([, z]) => z[0] === rack && z[1] === allee)?.[0];
      db.locations[id] = { id, depotId: d.id, rack, allee, etagere, case: 'C1', desc: family ? `${family} — étagère ${etagere.slice(1)}` : 'Réserve' };
    }
  }

  // Stock courant + rattachement aux emplacements
  const stocked = new Map(); // depotId → articles présents
  depots.forEach((d, di) => {
    const list = arts.filter((a, i) => di === 0 || rnd() > (di === 1 ? 0.12 : 0.3) || i < 3);
    stocked.set(d.id, list);
    const famIdx = {};
    for (const a of list) {
      const [rack, allee] = ZONES[a.family];
      const k = (famIdx[a.family] = (famIdx[a.family] ?? -1) + 1);
      const loc = Object.values(db.locations).find((l) => l.depotId === d.id && l.rack === rack && l.allee === allee && l.etagere === (k % 2 === 0 ? 'E1' : 'E2'));
      a.locations[d.id] = [loc.id];
      db.stocks[d.id][a.ean] = rnd() < 0.08 ? 0 : int(Math.ceil(a.threshold * 0.8), a.threshold * 6);
    }
    for (const a of arts) db.stocks[d.id][a.ean] ??= 0;
    // Quelques alertes visibles par dépôt
    for (const a of [...list].sort(() => rnd() - 0.5).slice(0, 3)) db.stocks[d.id][a.ean] = Math.max(0, Math.floor(a.threshold * (0.2 + rnd() * 0.6)));
  });
  // Article « réservoir » pour les transferts (stock confortable partout)
  const donor = arts[0];
  for (const d of depots) { db.stocks[d.id][donor.ean] = 160 + int(0, 40); if (!donor.locations[d.id]) donor.locations[d.id] = [Object.values(db.locations).find((l) => l.depotId === d.id).id]; }

  // Événements (du plus récent au plus ancien) → état « avant » reconstruit en remontant
  const events = [];
  const workTime = (daysAgo) => {
    const d = new Date(now.getTime() - daysAgo * DAY);
    d.setHours(int(7, 18), int(0, 59), int(0, 59), 0);
    return d > now ? new Date(now.getTime() - int(1, 90) * 60_000) : d;
  };
  for (const d of depots) {
    const pool = stocked.get(d.id);
    for (let i = 0; i < 52; i++) {
      const a = pick(pool);
      const type = rnd() < 0.5 ? 'in' : 'out';
      const qty = type === 'in' ? int(3, 24) : int(1, 14);
      events.push({ at: workTime(rnd() * 44), depot: d, art: a, type, qty, operator: pick(staff(d.id)), reason: type === 'out' ? pick(['Production', 'Production', 'Casse / rebut', 'Échantillon']) : pick(['Réception fournisseur', 'Réception fournisseur', 'Retour atelier']) });
    }
  }
  // Transferts : 2 en attente (dont 1 à recevoir par Paris), 1 reçu, 1 annulé
  const [paris, lyon, nice] = depots;
  const mk = (from, to, qty, daysAgo, status, extra = {}) => {
    const user = pick(staff(from.id));
    return { id: uid(now.getTime()), ean: donor.ean, name: donor.name, qty, fromDepotId: from.id, fromDepotName: from.name, toDepotId: to.id, toDepotName: to.name, operator: user.name, operatorId: user.id, date: workTime(daysAgo).toISOString(), status, ...extra };
  };
  const trs = [
    mk(lyon, paris, 8, 1, 'pending'),
    mk(paris, nice, 12, 2, 'pending'),
    mk(paris, lyon, 10, 7, 'done', { receivedBy: 'Marc Dubois', receivedDate: workTime(6).toISOString() }),
    mk(nice, paris, 5, 12, 'cancelled', { cancelledBy: 'Pierre Blanc', cancelledDate: workTime(12).toISOString() }),
  ];
  for (const t of trs) {
    const from = db.depots[t.fromDepotId], to = db.depots[t.toDepotId];
    const user = db.users[t.operatorId];
    events.push({ at: new Date(t.date), depot: from, art: donor, type: 'transfer', qty: t.qty, operator: user, note: `→ ${to.name}`, transferId: t.id });
    if (t.status === 'done') events.push({ at: new Date(t.receivedDate), depot: to, art: donor, type: 'transfer_in', qty: t.qty, operator: { name: t.receivedBy, id: null }, note: `← ${from.name}`, transferId: t.id });
    if (t.status === 'cancelled') events.push({ at: new Date(t.cancelledDate), depot: from, art: donor, type: 'transfer_cancel', qty: t.qty, operator: { name: t.cancelledBy, id: null }, note: 'Transfert annulé', transferId: t.id });
  }
  db.transfers = trs;

  const locOf = (art, depotId) => {
    const l = db.locations[art.locations[depotId]?.[0]];
    return l ? [l.rack, l.allee, l.etagere, l.case].join('-') : '';
  };
  const sign = { in: 1, transfer_in: 1, transfer_cancel: 1, out: -1, transfer: -1 };
  const state = {};
  for (const d of depots) state[d.id] = { ...db.stocks[d.id] };
  events.sort((a, b) => b.at - a.at);
  const history = [];
  for (const e of events) {
    const delta = sign[e.type] * e.qty;
    const cur = state[e.depot.id][e.art.ean] ?? 0;
    const before = cur - delta;
    if (before < 0) continue; // incohérent (stock insuffisant à l'époque) : événement ignoré
    state[e.depot.id][e.art.ean] = before;
    history.push({
      id: uid(e.at.getTime()), ean: e.art.ean, name: e.art.name, type: e.type, qty: e.qty, delta,
      depotId: e.depot.id, depotName: e.depot.name, operator: e.operator.name, ...(e.operator.id && { operatorId: e.operator.id }),
      date: e.at.toISOString(), ...(locOf(e.art, e.depot.id) && e.type !== 'transfer' && { loc: locOf(e.art, e.depot.id) }),
      ...(e.reason && { reason: e.reason }), ...(e.note && { note: e.note }), ...(e.transferId && { transferId: e.transferId }),
    });
  }
  db.history = history;

  // Audit : un enregistrement par mouvement + connexions + import initial
  const label = { in: 'Entrée +', out: 'Sortie −', transfer: 'Transfert ', transfer_in: 'Réception ', transfer_cancel: 'Transfert annulé ' };
  db.audit = history.map((h) => ({
    id: uid(new Date(h.date).getTime()), type: h.type === 'transfer_in' || h.type === 'transfer_cancel' ? 'transfer' : h.type,
    action: `${label[h.type]}${h.qty} × ${h.name}`, operator: h.operator, ...(h.operatorId && { operatorId: h.operatorId }),
    depotId: h.depotId, date: h.date, meta: { ean: h.ean, qty: h.qty },
  }));
  const admin = Object.values(db.users).find((u) => u.role === 'admin');
  for (let i = 0; i < 8; i++) {
    const u = pick(Object.values(db.users));
    db.audit.push({ id: uid(), type: 'login', action: `Connexion de ${u.name}`, operator: u.name, operatorId: u.id, depotId: u.depotId, date: workTime(i * 5 + rnd() * 3).toISOString(), meta: { role: u.role } });
  }
  db.audit.push({ id: uid(), type: 'admin', action: `Import catalogue : ${arts.length} créé(s), 0 modifié(s)`, operator: admin.name, operatorId: admin.id, depotId: depots[0].id, date: new Date(now.getTime() - 45 * DAY).toISOString(), meta: { created: arts.length } });
  db.audit.sort((a, b) => b.date.localeCompare(a.date));

  // État final = état « maintenant » (inchangé) ; l'historique est cohérent avec lui par construction
  return db;
}

/** Installation vide : un dépôt et un administrateur choisis par l'utilisateur. */
export async function buildFreshDb(now = new Date(), { adminName, pin, depotName, depotCode = '', depotLocation = '', pinIterations } = {}) {
  const db = emptyDb(now);
  const depotId = uid(now.getTime());
  db.depots[depotId] = { id: depotId, name: depotName, location: depotLocation, code: String(depotCode).toUpperCase().slice(0, 10) };
  db.stocks[depotId] = {};
  const id = uid(now.getTime());
  db.users[id] = { id, name: adminName, role: 'admin', depotId, pin: await hashPin(pin, pinIterations ? { iter: pinIterations } : undefined) };
  return db;
}
