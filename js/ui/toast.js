// Notifications. Construites avec textContent (jamais innerHTML) : sûres par construction.

const MAX = 3;

/**
 * @param {string} message
 * @param {{tone?:'info'|'ok'|'error', ms?:number, action?:{label:string, run:()=>void}}} [opt]
 * @returns {() => void} fonction de fermeture
 */
export function toast(message, { tone = 'info', ms, action } = {}) {
  const host = document.getElementById('toasts');
  if (!host) return () => {};
  const el = document.createElement('div');
  el.className = `toast${tone === 'error' ? ' toast--error' : tone === 'ok' ? ' toast--ok' : ''}`;
  if (tone === 'error') el.setAttribute('role', 'alert');
  const text = document.createElement('span');
  text.className = 'toast__text';
  text.textContent = message;
  el.append(text);

  let timer;
  const close = () => { clearTimeout(timer); el.remove(); };
  if (action) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'toast__action'; b.textContent = action.label;
    b.addEventListener('click', () => { close(); action.run(); });
    el.append(b);
  }
  host.append(el);
  while (host.children.length > MAX) host.firstElementChild.remove();
  const duration = ms ?? (action ? 8000 : tone === 'error' ? 5500 : 2800);
  const arm = () => { timer = setTimeout(close, duration); };
  el.addEventListener('pointerenter', () => clearTimeout(timer));
  el.addEventListener('pointerleave', arm);
  arm();
  return close;
}
