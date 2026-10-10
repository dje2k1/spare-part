// « Votre journée » : à la première ouverture du jour, une feuille récapitule ce qui demande une action
// (livraisons à réceptionner, commandes à préparer, ruptures prévues, seuils à revoir…). Désactivable
// pour toute l'organisation (Administration → Données) ; rouvrable depuis l'accueil.
import { html, fmtLongDate, localDay } from '../lib/text.js';
import { icon, actions } from './dom.js';
import { state, db, depot, storage } from './state.js';
import { briefing } from '../core/planning.js';
import { KEYS } from '../core/config.js';
import { openSheet, closeSheet } from './dialogs.js';
import { navigate } from './router.js';

const today = () => localDay(); // jour local : « une fois par jour » suit l'horloge de l'atelier, pas UTC
const seenKey = () => `${state.session.user.id}:${state.session.depotId}`;

function readSeen() { try { return JSON.parse(storage.getItem(KEYS.briefing)) || {}; } catch { return {}; } }
function markSeen(key = seenKey()) {
  const seen = readSeen();
  seen[key] = today();
  try { storage.setItem(KEYS.briefing, JSON.stringify(seen)); } catch { /* quota : sans gravité */ }
}

export function openBriefing() {
  const now = new Date();
  const key = seenKey(); // capturée maintenant : la feuille peut se fermer après la fin de la session (verrouillage)
  const items = briefing(db(), { depotId: depot().id, role: state.session.user.role, now });
  openSheet({
    title: 'Votre journée',
    body: html`<p class="muted briefing__date">${fmtLongDate(now)} · ${depot().name}</p>
      ${items.length ? html`<ul class="today__list briefing__list">${items.map((t) => html`<li><button type="button" class="today__item today__item--${t.tone}" data-action="briefing.go" data-to="${t.to}">
          ${icon(t.icon, 'i--sm')}<span class="grow"><strong>${t.title}</strong>${t.text ? html`<span class="today__text">${t.text}</span>` : ''}</span>${icon('chevron', 'i--sm')}</button></li>`)}</ul>`
        : html`<div class="empty">${icon('check', 'i--xl')}<p class="empty__title">Rien d'urgent aujourd'hui</p><p>Tout est à jour dans ce dépôt.</p></div>`}`,
    foot: html`<button type="button" class="btn btn--primary btn--block" data-action="sheet.close">C'est parti</button>`,
    onClose: () => markSeen(key),
  });
}

/** Après la connexion : une fois par jour, par personne et par dépôt, s'il y a quelque chose à signaler. */
export function maybeShowBriefing() {
  if (!state.session || !db().meta.settings.briefing) return;
  if (readSeen()[seenKey()] === today()) return;
  const items = briefing(db(), { depotId: depot().id, role: state.session.user.role, now: new Date() });
  if (items.length) openBriefing(); else markSeen();
}

export function initBriefing() {
  actions({
    async 'briefing.go'(el) {
      await closeSheet();
      const [path, qs] = el.dataset.to.split('?');
      navigate(path, { params: Object.fromEntries(new URLSearchParams(qs || '')) });
    },
  });
}
