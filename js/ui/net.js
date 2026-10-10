// Accès à l'API du serveur de synchronisation (même origine). Les chemins sont relatifs au document :
// l'application fonctionne aussi derrière un proxy qui la publie sous un sous-chemin (ex. /stock/).
export const apiUrl = (path) => new URL(`api/${String(path).replace(/^\/?(api\/)?/, '')}`, document.baseURI).href;

/**
 * @returns {Promise<{status:number, json:any}>} rejette (TypeError) si le réseau est indisponible ou trop lent
 */
export async function apiFetch(path, { method = 'GET', body, timeout = 30_000, signal } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  const stop = () => ctrl.abort();
  signal?.addEventListener('abort', stop, { once: true });
  try {
    const res = await fetch(apiUrl(path), {
      method, credentials: 'same-origin', cache: 'no-store', signal: ctrl.signal,
      headers: body !== undefined ? { 'content-type': 'application/json' } : {},
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch { /* corps vide ou non JSON */ }
    return { status: res.status, json };
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new TypeError(ctrl.signal.aborted ? 'Serveur trop lent à répondre' : 'Réseau indisponible');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
  }
}

/** Adaptateur attendu par le moteur de synchronisation. */
export const api = {
  get: (path) => apiFetch(path, { timeout: path.includes('snapshot') ? 90_000 : 30_000 }),
  post: (path, body) => apiFetch(path, { method: 'POST', body: body ?? {} }),
};
