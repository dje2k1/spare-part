// Administration : utilisateurs, dépôts, emplacements, import/export, données (sauvegarde, stockage, verrouillage, production).
import { html, fmtInt, fmtDateTime, plural } from '../../lib/text.js';
import { parse as parseCsv, stringify } from '../../lib/csv.js';
import { icon, actions, $, val, download } from '../dom.js';
import { db, depot, can, run, store, state, storage } from '../state.js';
import { saveUser, deleteUser, saveDepot, deleteDepot, saveLocation, deleteLocation, importCatalogue, updateSettings } from '../../core/ops.js';
import { hashPin, pinPolicy, upgradeLegacyPins } from '../../core/auth.js';
import { buildFreshDb } from '../../core/seed.js';
import { locCode, stockOf, daysSince, searchArticles } from '../../core/queries.js';
import { KEYS, ROLES } from '../../core/config.js';
import { pageHead, emptyState } from '../components.js';
import { openSheet, closeSheet, confirmDialog, promptDialog } from '../dialogs.js';
import { printLabels, printStockReport } from '../print.js';
import { endSession } from '../session.js';
import { refresh } from '../router.js';
import { toast } from '../toast.js';

const SECTIONS = [
  { key: 'users', perm: 'user.manage', icon: 'users', title: 'Utilisateurs et rôles', desc: 'Comptes, rôles, dépôts, PIN' },
  { key: 'depots', perm: 'depot.manage', icon: 'layers', title: 'Dépôts', desc: 'Sites de stockage' },
  { key: 'locations', perm: 'location.edit', icon: 'pin', title: 'Emplacements et étiquettes', desc: 'Racks, allées, QR codes' },
  { key: 'import', perm: 'import', icon: 'upload', title: 'Import du catalogue', desc: 'Fichier CSV avec aperçu' },
  { key: 'export', perm: 'export', icon: 'download', title: 'Exports et état de stock', desc: 'CSV, impression' },
  { key: 'data', perm: 'data.manage', icon: 'database', title: 'Données et sécurité', desc: 'Sauvegarde, stockage, verrouillage' },
];
const allowed = () => SECTIONS.filter((s) => can(s.perm));
const L = { depotId: null, csv: null };
const eanOf = (a) => a.ean;

// ── Écran ──
function render(r) {
  const key = r.params.get('s');
  const sec = allowed().find((s) => s.key === key);
  if (!sec) {
    return html`<section>${pageHead({ eyebrow: 'Paramètres', title: 'Administration' })}
      <ul class="list">${allowed().map((s) => html`<li><a class="row" href="#/admin?s=${s.key}"><span class="row__lead thumb">${icon(s.icon)}</span><span class="row__body"><span class="row__title">${s.title}</span><span class="row__meta">${s.desc}</span></span>${icon('chevron', 'i--sm')}</a></li>`)}</ul></section>`;
  }
  const body = { users, depots, locations, import: importer, export: exporter, data }[sec.key]();
  return html`<section>${pageHead({ eyebrow: 'Administration', title: sec.title })}${body}</section>`;
}

export const adminRoute = {
  title: (r) => allowed().find((s) => s.key === r.params.get('s'))?.title ?? 'Administration',
  back: true, perm: 'import', render,
};

// ── Utilisateurs ──
function users() {
  const list = Object.values(db().users).sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  return html`<div class="pad"><button type="button" class="btn btn--primary btn--sm" data-action="adm.user" data-id="">${icon('plus', 'i--sm')}Utilisateur</button></div>
    <ul class="list">${list.map((u) => html`<li><button type="button" class="row" data-action="adm.user" data-id="${u.id}"><span class="row__lead avatar">${u.name.charAt(0).toUpperCase()}</span>
      <span class="row__body"><span class="row__title">${u.name}</span><span class="row__meta">${ROLES[u.role].label} · ${db().depots[u.depotId]?.name ?? '—'}</span></span>${icon('chevron', 'i--sm')}</button></li>`)}</ul>`;
}

function userSheet(id) {
  const u = id ? db().users[id] : null;
  openSheet({
    title: u ? u.name : 'Nouvel utilisateur',
    body: html`<form class="stack" data-submit="adm.user.save" data-id="${id}" novalidate>
      <label class="field"><span class="field__label">Nom complet</span><input class="input" name="name" maxlength="60" value="${u?.name ?? ''}" required autocomplete="off"></label>
      <label class="field"><span class="field__label">Rôle</span><select class="select" name="role">${Object.entries(ROLES).map(([k, r]) => html`<option value="${k}" ${u?.role === k ? 'selected' : ''}>${r.label} — ${r.hint}</option>`)}</select></label>
      <label class="field"><span class="field__label">Dépôt</span><select class="select" name="depot">${Object.values(db().depots).map((d) => html`<option value="${d.id}" ${u?.depotId === d.id ? 'selected' : ''}>${d.name}</option>`)}</select></label>
      <label class="field"><span class="field__label">${u ? 'Nouveau PIN (laisser vide pour conserver)' : 'PIN (4 à 8 chiffres)'}</span><input class="input input--mono" name="pin" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="8" autocomplete="new-password" ${u ? '' : 'required'}></label>
      <p class="field__error" data-err role="alert"></p>
      <button type="submit" class="btn btn--primary btn--block">Enregistrer</button>
      ${u && u.id !== state.session.user.id ? html`<button type="button" class="btn btn--danger btn--block" data-action="adm.user.delete" data-id="${u.id}">${icon('trash')}Supprimer le compte</button>` : ''}</form>`,
  });
}

// ── Dépôts ──
function depots() {
  return html`<div class="pad"><button type="button" class="btn btn--primary btn--sm" data-action="adm.depot" data-id="">${icon('plus', 'i--sm')}Dépôt</button></div>
    <ul class="list">${Object.values(db().depots).map((d) => html`<li><button type="button" class="row" data-action="adm.depot" data-id="${d.id}"><span class="row__body"><span class="row__title">${d.name}</span><span class="row__meta">${d.location || '—'}${d.code ? ` · ${d.code}` : ''}</span></span>
      <span class="row__trail"><span class="row__qty num">${fmtInt(Object.values(db().stocks[d.id] ?? {}).reduce((s, v) => s + v, 0))}</span><span class="row__sub">unités</span></span></button></li>`)}</ul>`;
}

function depotSheet(id) {
  const d = id ? db().depots[id] : null;
  openSheet({
    title: d ? d.name : 'Nouveau dépôt',
    body: html`<form class="stack" data-submit="adm.depot.save" data-id="${id}" novalidate>
      <label class="field"><span class="field__label">Nom</span><input class="input" name="name" maxlength="60" value="${d?.name ?? ''}" required></label>
      <label class="field"><span class="field__label">Localisation</span><input class="input" name="location" maxlength="60" value="${d?.location ?? ''}"></label>
      <label class="field"><span class="field__label">Code</span><input class="input" name="code" maxlength="10" value="${d?.code ?? ''}" autocapitalize="characters" placeholder="DEP-01"></label>
      <p class="field__error" data-err role="alert"></p>
      <button type="submit" class="btn btn--primary btn--block">Enregistrer</button>
      ${d ? html`<button type="button" class="btn btn--danger btn--block" data-action="adm.depot.delete" data-id="${d.id}">${icon('trash')}Supprimer le dépôt</button>` : ''}</form>`,
  });
}

// ── Emplacements ──
function locations() {
  const depotId = L.depotId && db().depots[L.depotId] ? L.depotId : depot().id;
  const locs = Object.values(db().locations).filter((l) => l.depotId === depotId).sort((a, b) => locCode(a).localeCompare(locCode(b), 'fr', { numeric: true }));
  const refs = (l) => Object.values(db().articles).filter((a) => (a.locations[depotId] ?? []).includes(l.id)).length;
  return html`
    ${can('depot.any') && Object.keys(db().depots).length > 1 ? html`<div class="pad"><select class="select" data-change="adm.loc.depot" aria-label="Dépôt">${Object.values(db().depots).map((d) => html`<option value="${d.id}" ${d.id === depotId ? 'selected' : ''}>${d.name}</option>`)}</select></div>` : ''}
    <div class="pad flex flex--wrap"><button type="button" class="btn btn--primary btn--sm" data-action="adm.loc" data-id="">${icon('plus', 'i--sm')}Emplacement</button>
      ${locs.length && can('labels') ? html`<button type="button" class="btn btn--secondary btn--sm" data-action="adm.loc.labels" data-depot="${depotId}">${icon('printer', 'i--sm')}Toutes les étiquettes</button>` : ''}</div>
    ${locs.length ? html`<ul class="list">${locs.map((l) => html`<li><button type="button" class="row" data-action="adm.loc" data-id="${l.id}"><span class="row__body"><span class="row__title num">${locCode(l)}</span><span class="row__meta">${l.desc || 'Sans description'}</span></span>
      <span class="row__trail"><span class="row__sub">${plural(refs(l), 'réf.', 'réf.')}</span></span></button></li>`)}</ul>`
      : emptyState({ icon: 'pin', title: 'Aucun emplacement', text: 'Créez le premier emplacement de ce dépôt.' })}`;
}

function locSheet(id) {
  const l = id ? db().locations[id] : null;
  const depotId = l?.depotId ?? (L.depotId && db().depots[L.depotId] ? L.depotId : depot().id);
  openSheet({
    title: l ? locCode(l) : 'Nouvel emplacement',
    body: html`<form class="stack" data-submit="adm.loc.save" data-id="${id}" data-depot="${depotId}" novalidate>
      <div class="grid2">${[['rack', 'Rack', 'R1'], ['allee', 'Allée', 'A3'], ['etagere', 'Étagère', 'E2'], ['case', 'Case', 'C4']].map(([k, label, ph]) => html`<label class="field"><span class="field__label">${label}</span><input class="input input--mono" name="${k}" maxlength="8" value="${l?.[k] ?? ''}" placeholder="${ph}" autocapitalize="characters" autocomplete="off"></label>`)}</div>
      <label class="field"><span class="field__label">Description</span><input class="input" name="desc" maxlength="60" value="${l?.desc ?? ''}" placeholder="Zone bandoulières"></label>
      <p class="field__error" data-err role="alert"></p>
      <button type="submit" class="btn btn--primary btn--block">Enregistrer</button>
      ${l && can('labels') ? html`<button type="button" class="btn btn--secondary btn--block" data-action="adm.loc.label" data-id="${l.id}">${icon('qr')}Imprimer l'étiquette QR</button>` : ''}
      ${l ? html`<button type="button" class="btn btn--danger btn--block" data-action="adm.loc.delete" data-id="${l.id}">${icon('trash')}Supprimer</button>` : ''}</form>`,
  });
}

// ── Import ──
function importer() {
  return html`<div class="pad stack">
    <p class="muted">Importez un fichier CSV (séparateur « ; » ou « , », UTF-8). Colonnes reconnues : <code>ean13</code>, <code>name</code>, <code>family</code>, <code>ref</code>, <code>price</code>, <code>threshold</code> et, en option, <code>stock</code>. Un aperçu s'affiche avant toute écriture.</p>
    <label class="photo-drop" for="imp-file">${icon('upload', 'i--xl')}<span class="photo-drop__title">Choisir un fichier CSV</span></label>
    <input type="file" id="imp-file" class="sr-only" accept=".csv,text/csv,text/plain" data-change="adm.import.file">
    <button type="button" class="btn btn--ghost btn--sm" data-action="adm.import.template">${icon('download', 'i--sm')}Télécharger un modèle</button></div>`;
}

function importSheet(report, name) {
  openSheet({
    title: 'Aperçu de l\'import',
    body: html`<p class="muted">${name} · ${plural(report.total, 'ligne')}</p>
      <div class="kpis kpis--3">
        <div class="kpi"><span class="kpi__value num kpi__value--green">${report.created}</span><span class="kpi__label">À créer</span></div>
        <div class="kpi"><span class="kpi__value num">${report.updated}</span><span class="kpi__label">À modifier</span></div>
        <div class="kpi"><span class="kpi__value num ${report.skipped.length ? 'kpi__value--red' : ''}">${report.skipped.length}</span><span class="kpi__label">Ignorées</span></div></div>
      ${report.skipped.length ? html`<h3 class="eyebrow sheet-sec">Lignes ignorées</h3><ul class="plain-list plain-list--tight">${report.skipped.slice(0, 8).map((s) => html`<li><span>Ligne ${s.line}</span><span class="muted">${s.reason}</span></li>`)}${report.skipped.length > 8 ? html`<li class="muted">… et ${report.skipped.length - 8} autres</li>` : ''}</ul>` : ''}
      <label class="check sheet-sec"><input type="checkbox" id="imp-stock"><span>Appliquer aussi la colonne <code>stock</code> au dépôt « ${depot().name} » <span class="muted">(écarts tracés comme inventaire)</span></span></label>`,
    foot: html`<button type="button" class="btn btn--secondary" data-action="sheet.close">Annuler</button><button type="button" class="btn btn--primary" data-action="adm.import.apply" ${report.created + report.updated ? '' : 'disabled'}>Importer</button>`,
  });
}

// ── Exports ──
function exporter() {
  return html`<div class="pad stack">
    <button type="button" class="btn btn--secondary btn--block" data-action="adm.export.stock">${icon('download')}Stock actuel (CSV)</button>
    <button type="button" class="btn btn--secondary btn--block" data-action="adm.export.catalog">${icon('download')}Catalogue complet, tous dépôts (CSV)</button>
    <h3 class="eyebrow">État de stock imprimable</h3>
    <label class="field"><span class="field__label">Filtre</span><select class="select" id="print-filter"><option value="all">Tous les articles</option><option value="nonzero">En stock uniquement</option><option value="alert">Alertes uniquement</option></select></label>
    <button type="button" class="btn btn--primary btn--block" data-action="adm.export.print">${icon('printer')}Imprimer / enregistrer en PDF</button></div>`;
}

// ── Données ──
function data() {
  const m = db().meta;
  const age = daysSince(m.lastBackupAt);
  return html`<div class="pad stack">
    <section class="card stack"><h3 class="card__title">${icon('download', 'i--sm')} Sauvegarde</h3>
      <p class="muted">Toutes les données vivent sur cet appareil. ${m.lastBackupAt ? `Dernière sauvegarde : ${fmtDateTime(m.lastBackupAt)}${Number.isFinite(age) && age > 0 ? ` (il y a ${age} j)` : ''}.` : '<strong>Aucune sauvegarde exportée.</strong>'} ${plural(store.changesSinceBackup(), 'modification')} depuis.</p>
      <button type="button" class="btn btn--primary btn--block" data-action="adm.backup">${icon('download')}Exporter une sauvegarde (JSON)</button>
      <label class="btn btn--secondary btn--block" for="restore-file">${icon('upload')}Restaurer une sauvegarde…</label>
      <input type="file" id="restore-file" class="sr-only" accept="application/json,.json" data-change="adm.restore"></section>
    <section class="card stack"><h3 class="card__title">${icon('database', 'i--sm')} Stockage</h3><p class="muted" id="storage-info">Calcul en cours…</p></section>
    <section class="card stack"><h3 class="card__title">${icon('lock', 'i--sm')} Verrouillage automatique</h3>
      <label class="field"><span class="field__label">Se verrouiller après inactivité</span><select class="select" data-change="adm.lock">${[[0, 'Jamais'], [5, '5 minutes'], [10, '10 minutes'], [15, '15 minutes'], [30, '30 minutes'], [60, '1 heure']].map(([v, l]) => html`<option value="${v}" ${v === m.settings.sessionMinutes ? 'selected' : ''}>${l}</option>`)}</select></label></section>
    ${m.demo ? html`<section class="card card--gold stack"><h3 class="card__title">${icon('sparkles', 'i--sm')} Mode démonstration</h3>
      <p class="muted">Ces données sont fictives. Passez en production pour partir d'un atelier vide avec votre propre administrateur.</p>
      <button type="button" class="btn btn--primary btn--block" data-action="adm.production">Passer en production…</button></section>` : ''}
    <section class="card stack"><h3 class="card__title text-red">Zone sensible</h3>
      <button type="button" class="btn btn--danger btn--block" data-action="adm.wipe">${icon('trash')}Effacer toutes les données de cet appareil</button></section></div>`;
}

async function paintStorage() {
  const el = $('#storage-info');
  if (!el) return;
  const own = store.sizeBytes();
  let text = `Base de données : ${(own / 1024).toFixed(0)} Ko.`;
  try {
    const est = await navigator.storage?.estimate?.();
    const persisted = await navigator.storage?.persisted?.();
    if (est?.quota) text += ` Quota du navigateur : ${(est.quota / 1048576).toFixed(0)} Mo (${((est.usage / est.quota) * 100).toFixed(1)} % utilisé).`;
    if (persisted !== undefined) text += persisted ? ' Stockage protégé contre l\'effacement automatique.' : ' Stockage non protégé : le navigateur pourrait l\'effacer en cas de manque de place — exportez des sauvegardes.';
  } catch { /* estimation indisponible */ }
  if (storage.volatile) text += ' ⚠ Navigation privée : les données seront perdues à la fermeture.';
  el.textContent = text;
}

const importRows = (rows, opts) => run((d, c) => importCatalogue(d, c, rows, opts));
const stamp = () => new Date().toISOString().slice(0, 10);
const formErr = (form, e) => { if (e.isOpError) { form.querySelector('[data-err]').textContent = e.message; return true; } return false; };

export function initAdmin() {
  actions({
    // Utilisateurs
    'adm.user': (el) => userSheet(el.dataset.id || null),
    async 'adm.user.save'(form) {
      const id = form.dataset.id || undefined;
      const pinText = val(form, 'pin');
      try {
        let pin = null;
        if (pinText || !id) { const pol = pinPolicy(pinText); if (!pol.ok) { form.querySelector('[data-err]').textContent = pol.reason; return; } pin = await hashPin(pinText); }
        run(saveUser, { id, name: val(form, 'name'), role: val(form, 'role'), depotId: val(form, 'depot'), pin });
        await closeSheet(); toast('Utilisateur enregistré.', { tone: 'ok' }); refresh();
      } catch (e) { if (!formErr(form, e)) throw e; }
    },
    async 'adm.user.delete'(el) {
      if (!(await confirmDialog({ title: 'Supprimer ce compte ?', message: db().users[el.dataset.id].name, confirmLabel: 'Supprimer', danger: true }))) return;
      run(deleteUser, el.dataset.id); await closeSheet(); toast('Compte supprimé.'); refresh();
    },
    // Dépôts
    'adm.depot': (el) => depotSheet(el.dataset.id || null),
    async 'adm.depot.save'(form) {
      try { run(saveDepot, { id: form.dataset.id || undefined, name: val(form, 'name'), location: val(form, 'location'), code: val(form, 'code') }); await closeSheet(); toast('Dépôt enregistré.', { tone: 'ok' }); refresh(); } catch (e) { if (!formErr(form, e)) throw e; }
    },
    async 'adm.depot.delete'(el) {
      if (!(await confirmDialog({ title: 'Supprimer ce dépôt ?', message: 'Ses emplacements seront supprimés. L\'opération est refusée s\'il reste du stock.', confirmLabel: 'Supprimer', danger: true }))) return;
      run(deleteDepot, el.dataset.id); await closeSheet(); toast('Dépôt supprimé.'); refresh();
    },
    // Emplacements
    'adm.loc.depot': (el) => { L.depotId = el.value; refresh(); },
    'adm.loc': (el) => locSheet(el.dataset.id || null),
    async 'adm.loc.save'(form) {
      try {
        run(saveLocation, { id: form.dataset.id || undefined, depotId: form.dataset.depot, rack: val(form, 'rack'), allee: val(form, 'allee'), etagere: val(form, 'etagere'), case: val(form, 'case'), desc: val(form, 'desc') });
        await closeSheet(); toast('Emplacement enregistré.', { tone: 'ok' }); refresh();
      } catch (e) { if (!formErr(form, e)) throw e; }
    },
    async 'adm.loc.delete'(el) {
      if (!(await confirmDialog({ title: 'Supprimer cet emplacement ?', message: 'Les pièces qui y sont rangées perdent cet emplacement.', confirmLabel: 'Supprimer', danger: true }))) return;
      run(deleteLocation, el.dataset.id); await closeSheet(); toast('Emplacement supprimé.'); refresh();
    },
    'adm.loc.label': (el) => { const l = db().locations[el.dataset.id]; printLabels([{ kind: 'location', loc: l, depot: db().depots[l.depotId] }]); },
    'adm.loc.labels': (el) => {
      const locs = Object.values(db().locations).filter((l) => l.depotId === el.dataset.depot).sort((a, b) => locCode(a).localeCompare(locCode(b), 'fr', { numeric: true }));
      printLabels(locs.map((l) => ({ kind: 'location', loc: l, depot: db().depots[l.depotId] })));
    },
    // Import
    async 'adm.import.file'(input) {
      const f = input.files?.[0];
      if (!f) return;
      if (f.size > 5 * 1024 * 1024) { toast('Fichier trop volumineux (5 Mo maximum).', { tone: 'error' }); return; }
      L.csv = { text: await f.text(), name: f.name };
      input.value = '';
      const { rows } = parseCsv(L.csv.text);
      if (!rows.length) { toast('Aucune ligne de données trouvée dans ce fichier.', { tone: 'error' }); return; }
      importSheet(importRows(rows, { dryRun: true }), L.csv.name);
    },
    async 'adm.import.apply'() {
      if (!L.csv) return;
      try {
        const r = importRows(parseCsv(L.csv.text).rows, { applyStock: Boolean($('#imp-stock')?.checked) });
        L.csv = null;
        await closeSheet();
        toast(`Import terminé : ${r.created} créé(s), ${r.updated} modifié(s)${r.stockSet ? `, ${plural(r.stockSet, 'stock ajusté', 'stocks ajustés')}` : ''}.`, { tone: 'ok', ms: 5000 });
        refresh();
      } catch (e) { if (!e.isOpError) throw e; toast(e.message, { tone: 'error' }); }
    },
    'adm.import.template': () => download('modele-catalogue.csv', stringify([{ ean13: '3700089690011', name: 'Bandoulière cuir 120cm', family: 'Bandoulières', ref: 'BND-CN-120', price: '18,5', threshold: 15, stock: 40 }], ['ean13', 'name', 'family', 'ref', 'price', 'threshold', 'stock'].map((k) => ({ key: k, label: k }))), 'text/csv'),
    // Exports
    'adm.export.stock': () => {
      const rows = searchArticles(db(), depot().id, { sort: 'loc' });
      download(`stock-${depot().code || 'depot'}-${stamp()}.csv`, stringify(rows, [
        { label: 'Emplacement', get: (r) => (r.locs[0] ? locCode(r.locs[0]) : '') }, { label: 'EAN', get: (r) => r.article.ean }, { label: 'Désignation', get: (r) => r.article.name },
        { label: 'Famille', get: (r) => r.article.family }, { label: 'Référence', get: (r) => r.article.ref }, { label: 'Stock', get: (r) => r.qty }, { label: 'Seuil', get: (r) => r.article.threshold },
        { label: 'Prix unitaire', get: (r) => String(r.article.price).replace('.', ',') }, { label: 'Valeur', get: (r) => String(Math.round(r.qty * r.article.price * 100) / 100).replace('.', ',') },
      ]), 'text/csv');
    },
    'adm.export.catalog': () => {
      const ds = Object.values(db().depots);
      download(`catalogue-${stamp()}.csv`, stringify(Object.values(db().articles), [
        { label: 'ean13', get: eanOf }, { label: 'name', get: (a) => a.name }, { label: 'family', get: (a) => a.family }, { label: 'ref', get: (a) => a.ref },
        { label: 'price', get: (a) => String(a.price).replace('.', ',') }, { label: 'threshold', get: (a) => a.threshold },
        ...ds.map((d) => ({ label: `stock ${d.code || d.name}`, get: (a) => stockOf(db(), d.id, a.ean) })),
      ]), 'text/csv');
    },
    'adm.export.print': () => {
      const f = $('#print-filter').value;
      const rows = searchArticles(db(), depot().id, { sort: 'loc', filter: f === 'alert' ? 'alert' : 'all' }).filter((r) => f !== 'nonzero' || r.qty > 0);
      printStockReport({ title: 'Atelier — État de stock', subtitle: depot().name, rows: rows.map((r) => ({ loc: r.locs[0] ? locCode(r.locs[0]) : '', family: r.article.family, name: r.article.name, ean: r.article.ean, threshold: r.article.threshold, qty: r.qty, alert: r.status !== 'ok' })) });
    },
    // Données
    'adm.backup': () => {
      download(`mode-stock-sauvegarde-${stamp()}.json`, store.exportBackup(), 'application/json');
      toast('Sauvegarde exportée. Conservez ce fichier en lieu sûr : il contient les empreintes de PIN.', { tone: 'ok', ms: 6000 });
      refresh();
    },
    async 'adm.restore'(input) {
      const f = input.files?.[0];
      if (!f) return;
      try {
        const { db: restored, exportedAt } = store.importBackup(await f.text());
        const ok = await confirmDialog({ title: 'Remplacer toutes les données ?', message: `La sauvegarde du ${fmtDateTime(exportedAt)} (${plural(Object.keys(restored.articles).length, 'article')}, ${plural(Object.keys(restored.users).length, 'utilisateur')}) remplacera les données actuelles. Vous serez déconnecté.`, confirmLabel: 'Restaurer', danger: true });
        if (!ok) return;
        await upgradeLegacyPins(restored);
        endSession('Sauvegarde restaurée : reconnectez-vous.', { replaceDb: restored });
      } catch (e) { toast(e.message, { tone: 'error' }); }
      input.value = '';
    },
    'adm.lock'(el) { run(updateSettings, { sessionMinutes: el.value }); toast('Réglage enregistré.', { tone: 'ok' }); },
    async 'adm.production'() {
      openSheet({
        title: 'Passer en production',
        body: html`<form class="stack" data-submit="adm.production.go" novalidate>
          <p class="muted">Toutes les données de démonstration seront effacées. Vous repartez d'un atelier vide.</p>
          <label class="field"><span class="field__label">Nom du dépôt</span><input class="input" name="depot" maxlength="60" required></label>
          <label class="field"><span class="field__label">Code (facultatif)</span><input class="input" name="code" maxlength="10"></label>
          <label class="field"><span class="field__label">Administrateur</span><input class="input" name="admin" maxlength="60" value="${state.session.user.name === 'Administrateur' ? '' : state.session.user.name}" required></label>
          <label class="field"><span class="field__label">PIN (4 à 8 chiffres)</span><input class="input input--mono" name="pin" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="8" autocomplete="new-password" required></label>
          <label class="field"><span class="field__label">Confirmer le PIN</span><input class="input input--mono" name="pin2" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="8" autocomplete="new-password" required></label>
          <p class="field__error" data-err role="alert"></p>
          <button type="submit" class="btn btn--danger btn--block">Effacer la démo et démarrer</button></form>`,
      });
    },
    async 'adm.production.go'(form) {
      const err = form.querySelector('[data-err]');
      const pin = val(form, 'pin');
      if (!val(form, 'depot') || !val(form, 'admin')) { err.textContent = 'Renseignez le dépôt et l\'administrateur.'; return; }
      const pol = pinPolicy(pin);
      if (!pol.ok) { err.textContent = pol.reason; return; }
      if (pin !== val(form, 'pin2')) { err.textContent = 'Les deux PIN ne correspondent pas.'; return; }
      if (!(await confirmDialog({ title: 'Effacer les données de démonstration ?', message: 'Cette action est définitive.', confirmLabel: 'Effacer', danger: true }))) return;
      const fresh = await buildFreshDb(new Date(), { adminName: val(form, 'admin'), pin, depotName: val(form, 'depot'), depotCode: val(form, 'code') });
      await closeSheet();
      endSession('Atelier créé : connectez-vous avec votre compte administrateur.', { replaceDb: fresh });
    },
    async 'adm.wipe'() {
      const word = await promptDialog({ title: 'Effacer toutes les données ?', label: 'Tapez EFFACER pour confirmer', hint: 'Les données de cet appareil seront supprimées définitivement. Exportez une sauvegarde avant.', confirmLabel: 'Effacer', validate: (v) => (v === 'EFFACER' ? '' : 'Tapez exactement EFFACER.') });
      if (word !== 'EFFACER') return;
      try { storage.removeItem(KEYS.db); storage.removeItem(KEYS.session); } catch { /* ignoré */ }
      location.assign(location.pathname);
    },
  });
}
