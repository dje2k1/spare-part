// Accueil : situation du dépôt, tâches à traiter, actions principales, activité récente.
import { html, fmtInt, fmtLongDate, plural } from '../../lib/text.js';
import { icon, actions } from '../dom.js';
import { state, store, db, depot, can } from '../state.js';
import { kpis, movesToday, pendingIncoming, daysSince } from '../../core/queries.js';
import { APP_LABEL } from '../../core/config.js';
import { movementRow, kpi } from '../components.js';
import { navigate } from '../router.js';
import { switchDepot, updateChrome } from '../session.js';

function tasks(now) {
  const d = depot();
  const k = kpis(db(), d.id, { days: 30, now });
  const out = [];
  const incoming = pendingIncoming(db(), d.id);
  if (incoming.length) {
    out.push({ ic: 'swap', tone: 'info', to: 'transfers', title: `${plural(incoming.length, 'transfert')} à réceptionner`, text: incoming.slice(0, 2).map((t) => `${t.qty} × ${t.name}`).join(', ') + (incoming.length > 2 ? '…' : '') });
  }
  if (k.alerts) {
    out.push({ ic: 'alert', tone: 'low', to: can('stock.adjust') ? 'reorder' : 'articles?f=alert', title: `${plural(k.alerts, 'article')} sous le seuil d'alerte`, text: can('stock.adjust') ? 'Voir la liste de réassort' : 'Voir les articles concernés' });
  }
  if (can('export')) {
    const age = daysSince(db().meta.lastBackupAt, now);
    const changes = store.changesSinceBackup();
    if (changes >= 20 && age >= 7) {
      out.push({ ic: 'download', tone: 'info', to: 'admin?s=data', title: 'Sauvegarde conseillée', text: Number.isFinite(age) ? `${plural(changes, 'modification')} depuis la dernière sauvegarde (il y a ${age} j).` : 'Les données ne sont conservées que sur cet appareil.' });
    }
  }
  if (can('data.manage') && db().meta.demo) {
    out.push({ ic: 'sparkles', tone: 'gold', to: 'admin?s=data', title: 'Données de démonstration', text: 'Passez en production pour saisir vos vraies données.' });
  }
  if (store.status.trimmed) {
    out.push({ ic: 'database', tone: 'low', to: 'admin?s=data', title: 'Stockage presque plein', text: 'Les plus anciens journaux ont été élagués. Exportez une sauvegarde.' });
  }
  return out;
}

function render() {
  const d = depot();
  const u = state.session.user;
  const now = new Date();
  const k = kpis(db(), d.id, { days: 30, now });
  const hello = now.getHours() >= 18 ? 'Bonsoir' : 'Bonjour';
  const todo = tasks(now);
  const recent = db().history.filter((h) => h.depotId === d.id).slice(0, 6);
  const multi = can('depot.any') && Object.keys(db().depots).length > 1;
  return html`
    <section class="home">
      <div class="hero">
        <span class="pill pill--gold" data-testid="version-pill"><span class="pill__dot" aria-hidden="true"></span>${APP_LABEL}</span>
        <h2 class="hero__hello">${hello}, <em>${u.name.split(' ')[0]}</em></h2>
        <p class="muted hero__date">${fmtLongDate(now)}</p>
        ${multi ? html`<label class="hero__depot"><span class="sr-only">Dépôt actif</span>${icon('pin', 'i--sm')}
          <select class="select select--plain" data-change="home.depot" aria-label="Dépôt actif">${Object.values(db().depots).map((x) => html`<option value="${x.id}" ${x.id === d.id ? 'selected' : ''}>${x.name}</option>`)}</select></label>` : html`<p class="hero__depot-name">${icon('pin', 'i--sm')}${d.name}</p>`}
      </div>

      <div class="kpis kpis--3">
        ${kpi({ label: 'Unités en stock', value: fmtInt(k.units) })}
        ${kpi({ label: 'Alertes', value: fmtInt(k.alerts), tone: k.alerts ? 'red' : 'green', action: 'home.alerts' })}
        ${kpi({ label: "Mouvements aujourd'hui", value: fmtInt(movesToday(db(), d.id, now)) })}
      </div>

      ${todo.length ? html`<h3 class="section-title eyebrow">À traiter</h3>
        <ul class="tasks">${todo.map((t) => html`<li><button type="button" class="task task--${t.tone}" data-action="home.go" data-to="${t.to}">
          <span class="task__icon">${icon(t.ic)}</span>
          <span class="task__body"><strong>${t.title}</strong><span>${t.text}</span></span>${icon('chevron', 'i--sm')}</button></li>`)}</ul>` : ''}

      <h3 class="section-title eyebrow">Actions</h3>
      <div class="actions">
        <a class="action action--in" href="#/scan/in"><span class="action__icon">${icon('in')}</span><span class="action__title">Recevoir</span><span class="action__desc">Entrée de stock</span></a>
        <a class="action action--out" href="#/scan/out"><span class="action__icon">${icon('out')}</span><span class="action__title">Expédier</span><span class="action__desc">Sortie de stock</span></a>
        <a class="action action--transfer" href="#/scan/transfer"><span class="action__icon">${icon('swap')}</span><span class="action__title">Transférer</span><span class="action__desc">Vers un autre dépôt</span></a>
        ${can('inventory')
          ? html`<a class="action action--inv" href="#/inventory"><span class="action__icon">${icon('clipboard')}</span><span class="action__title">Inventaire</span><span class="action__desc">Comptage guidé</span></a>`
          : html`<a class="action action--inv" href="#/articles"><span class="action__icon">${icon('search')}</span><span class="action__title">Rechercher</span><span class="action__desc">Trouver une pièce</span></a>`}
      </div>

      <div class="flex flex--between section-head">
        <h3 class="eyebrow">Activité récente</h3>
        <a class="btn btn--text" href="#/journal">Tout voir</a>
      </div>
      ${recent.length ? html`<div class="list">${recent.map((h) => movementRow(h, { now }))}</div>`
        : html`<div class="empty"><p class="empty__title">Aucune activité</p><p>Les mouvements apparaîtront ici dès la première opération.</p></div>`}
    </section>`;
}

export const homeRoute = { title: 'Accueil', brand: true, nav: 'home', render };

export function initHome() {
  actions({
    'home.go': (el) => navigate(el.dataset.to.split('?')[0], { params: Object.fromEntries(new URLSearchParams(el.dataset.to.split('?')[1] || '')) }),
    'home.alerts': () => navigate('articles', { params: { f: 'alert' } }),
    'home.depot': (el) => { switchDepot(el.value); updateChrome(); navigate('home', { replace: true }); },
  });
}

