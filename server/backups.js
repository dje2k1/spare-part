// Sauvegardes automatiques du serveur : une sauvegarde complète par jour (au format d'import : Administration →
// Restaurer), dans DATA_DIR/backups, les N derniers jours conservés. Elles permettent de revenir à la veille après
// une erreur (restauration du mauvais fichier, suppression en masse…) sans dépendre de la seule sauvegarde du volume.
import { mkdirSync, readdirSync, statSync, writeFileSync, renameSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const NAME = /^mode-stock-(\d{4}-\d{2}-\d{2})\.json$/;
const pad = (n) => String(n).padStart(2, '0');
/** Jour local du serveur (AAAA-MM-JJ). */
const day = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/**
 * @param {{dir:string, keep?:number, now?:()=>Date, log?:object, text:()=>string}} o
 *   `text` : contenu de la sauvegarde (makeBackup de la base courante)
 */
export function createBackups({ dir, keep = 14, now = () => new Date(), log = console, text }) {
  mkdirSync(dir, { recursive: true });
  let timer = null;

  const list = () => readdirSync(dir).filter((n) => NAME.test(n)).sort().reverse()
    .map((name) => { const st = statSync(join(dir, name)); return { name, day: NAME.exec(name)[1], size: st.size, savedAt: st.mtime.toISOString() }; });

  /** Écrit (ou remplace) la sauvegarde du jour, puis supprime les plus anciennes au-delà de `keep`. */
  function run() {
    const name = `mode-stock-${day(now())}.json`;
    const tmp = join(dir, `${name}.tmp`);
    writeFileSync(tmp, text());
    renameSync(tmp, join(dir, name));
    for (const old of list().slice(keep)) rmSync(join(dir, old.name), { force: true });
    log.info?.(`sauvegarde automatique : ${name}`);
    return name;
  }

  /** Sauvegarde du jour manquante ? (au démarrage, puis vérifié toutes les heures) */
  function check() {
    try { if (list()[0]?.day !== day(now())) run(); } catch (e) { log.error?.('sauvegarde automatique impossible', e); }
  }

  return {
    keep,
    list,
    run,
    check,
    /** Contenu d'une sauvegarde par son nom (jamais un autre fichier). @returns {Buffer|null} */
    read(name) {
      if (typeof name !== 'string' || !NAME.test(name)) return null;
      try { return readFileSync(join(dir, name)); } catch { return null; }
    },
    start() { check(); timer = setInterval(check, 3_600_000); timer.unref?.(); },
    stop() { clearInterval(timer); timer = null; },
  };
}
