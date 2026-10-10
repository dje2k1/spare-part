// Journal : mouvements de stock et (responsables) journal d'audit, filtrables et exportables.
import { html, fmtDateTime, localDay } from '../../lib/text.js';
import { stringify } from '../../lib/csv.js';
import { isImageDataUrl } from '../../lib/image.js';
import { icon, actions, $, setHtml, download } from '../dom.js';
import { db, depot, can } from '../state.js';
import { movements, auditEntries } from '../../core/queries.js';
import { MOVES, AUDIT_TYPES } from '../../core/config.js';
import { pageHead, segmented, chips, movementRow, emptyState } from '../components.js';
import { refresh } from '../router.js';

const DAY = 86_400_000;
const J = { tab: 'moves', q: '', type: 'all', days: 30, all: false, aType: 'all', limit: 80 };
let timer = null;

const TYPE_FILTERS = { all: null, in: ['in'], out: ['out'], transfer: ['transfer', 'transfer_in', 'transfer_cancel'], inv: ['inv'] };
const AUDIT_ICON = { in: 'in', out: 'out', inv: 'clipboard', transfer: 'swap', order: 'truck', login: 'lock', admin: 'settings' };

function movesQuery(limit = J.limit) {
  return movements(db(), {
    depotId: J.all && can('depot.any') ? null : depot().id,
    types: TYPE_FILTERS[J.type], q: J.q, since: J.days ? Date.now() - J.days * DAY : 0, limit,
  });
}
function auditQuery(limit = J.limit) {
  return auditEntries(db(), { depotId: can('depot.any') && J.all ? null : depot().id, type: J.aType, q: J.q, limit });
}

function render() {
  const tabs = can('audit.view') ? [{ value: 'moves', label: 'Mouvements' }, { value: 'audit', label: 'Audit' }] : null;
  if (!tabs) J.tab = 'moves';
  const isMoves = J.tab === 'moves';
  return html`
    <section>
      ${pageHead({ eyebrow: 'Traçabilité', title: 'Journal', sub: J.all && can('depot.any') ? 'Tous les dépôts' : depot().name,
        actions: can('export') ? html`<button type="button" class="btn btn--secondary btn--sm" data-action="journal.csv">${icon('download', 'i--sm')}CSV</button>` : '' })}
      <div class="sticky-tools">
        ${tabs ? html`<div class="pad pad--tight">${segmented({ action: 'journal.tab', value: J.tab, items: tabs, label: 'Journal' })}</div>` : ''}
        <div class="searchbar">${icon('search')}<input class="input" type="search" placeholder="${isMoves ? 'Pièce, code, opérateur, motif…' : 'Action, opérateur, code…'}" value="${J.q}" autocomplete="off" aria-label="Rechercher" data-input="journal.search"></div>
        ${isMoves
          ? chips({ action: 'journal.type', value: J.type, label: 'Type', items: [{ value: 'all', label: 'Tout' }, { value: 'in', label: 'Entrées' }, { value: 'out', label: 'Sorties' }, { value: 'transfer', label: 'Transferts' }, { value: 'inv', label: 'Inventaires' }] })
          : chips({ action: 'journal.atype', value: J.aType, label: 'Type', items: [{ value: 'all', label: 'Tout' }, ...Object.entries(AUDIT_TYPES).map(([value, label]) => ({ value, label }))] })}
        <div class="toolbar">
          ${isMoves ? html`<select class="select select--plain" data-change="journal.days" aria-label="Période">${[[7, '7 jours'], [30, '30 jours'], [90, '90 jours'], [0, 'Tout']].map(([v, l]) => html`<option value="${v}" ${v === J.days ? 'selected' : ''}>${l}</option>`)}</select>` : ''}
          ${can('depot.any') && Object.keys(db().depots).length > 1 ? html`<label class="check check--inline"><input type="checkbox" data-change="journal.all" ${J.all ? 'checked' : ''}><span>Tous les dépôts</span></label>` : ''}
        </div>
      </div>
      <div id="journal-list"></div>
    </section>`;
}

function paintList() {
  const host = $('#journal-list');
  if (!host) return;
  const multi = Object.keys(db().depots).length > 1 && J.all;
  if (J.tab === 'moves') {
    const rows = movesQuery(J.limit + 1);
    if (!rows.length) { setHtml(host, emptyState({ icon: 'clock', title: 'Aucun mouvement', text: J.q || J.type !== 'all' ? 'Aucun résultat pour ces filtres.' : 'Les opérations apparaîtront ici.' })); return; }
    setHtml(host, html`<div class="list">${rows.slice(0, J.limit).map((h) => movementRow(h, { depot: multi }))}</div>${more(rows.length > J.limit)}`);
  } else {
    const rows = auditQuery(J.limit + 1);
    if (!rows.length) { setHtml(host, emptyState({ icon: 'shield', title: 'Aucune entrée' })); return; }
    setHtml(host, html`<div class="list">${rows.slice(0, J.limit).map((e) => html`
      <div class="row"><span class="row__lead audit-ico audit-ico--${e.type}">${icon(AUDIT_ICON[e.type] ?? 'info')}</span>
        <span class="row__body"><span class="row__title">${e.action}</span><span class="row__meta">${e.operator} · ${fmtDateTime(e.date)}${e.meta?.depotName ? ` · ${e.meta.depotName}` : ''}</span></span>
        ${isImageDataUrl(e.meta?.sig) ? html`<span class="row__trail"><img class="sig-thumb" src="${e.meta.sig}" alt="Signature du responsable"></span>` : ''}</div>`)}</div>${more(rows.length > J.limit)}`);
  }
}

const more = (yes) => (yes ? html`<div class="pad center"><button type="button" class="btn btn--secondary" data-action="journal.more">Afficher plus</button></div>` : '');

export const journalRoute = { title: 'Journal', back: true, render, mount: paintList };

export function initJournal() {
  actions({
    'journal.tab': (el) => { J.tab = el.dataset.value; J.q = ''; J.limit = 80; refresh(); },
    'journal.search': (el) => { clearTimeout(timer); timer = setTimeout(() => { J.q = el.value; J.limit = 80; paintList(); }, 120); },
    'journal.type': (el) => { J.type = el.dataset.value; J.limit = 80; refresh(); },
    'journal.atype': (el) => { J.aType = el.dataset.value; J.limit = 80; refresh(); },
    'journal.days': (el) => { J.days = Number(el.value); J.limit = 80; paintList(); },
    'journal.all': (el) => { J.all = el.checked; J.limit = 80; refresh(); },
    'journal.more': () => { J.limit += 80; paintList(); },
    'journal.csv': () => {
      const stamp = localDay();
      if (J.tab === 'moves') {
        download(`mouvements-${stamp}.csv`, stringify(movesQuery(5000), [
          { label: 'Date', get: (h) => h.date }, { label: 'Dépôt', get: (h) => h.depotName }, { label: 'Type', get: (h) => MOVES[h.type]?.label ?? h.type },
          { label: 'EAN', get: (h) => h.ean }, { label: 'Désignation', get: (h) => h.name }, { label: 'Quantité', get: (h) => h.qty }, { label: 'Variation', get: (h) => h.delta },
          { label: 'Opérateur', get: (h) => h.operator }, { label: 'Emplacement', get: (h) => h.loc }, { label: 'Motif', get: (h) => h.reason }, { label: 'Note', get: (h) => h.note },
        ]), 'text/csv');
      } else {
        download(`audit-${stamp}.csv`, stringify(auditQuery(5000), [
          { label: 'Date', get: (e) => e.date }, { label: 'Type', get: (e) => AUDIT_TYPES[e.type] ?? e.type }, { label: 'Action', get: (e) => e.action }, { label: 'Opérateur', get: (e) => e.operator },
        ]), 'text/csv');
      }
    },
  });
}
