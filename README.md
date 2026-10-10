# MODE — Gestion de stock

Application web (PWA) de gestion de stock de pièces détachées pour un atelier multi-dépôts : scan de codes-barres,
entrées / sorties / transferts, inventaire guidé signé, plan des emplacements, réassort, tableau de bord.
**Aucun serveur, aucune compilation** : des fichiers statiques servis par GitHub Pages ; les données restent sur l'appareil.

> Version 2 · hors-ligne après la première visite · mobile d'abord · thème clair / sombre

## Utiliser l'application

Si GitHub Pages est activé sur la branche `main` (réglages du dépôt → Pages), l'application est servie à
`https://<compte>.github.io/spare-part/`. Au premier lancement : **données de démonstration**, **nouvelle installation**
(vous choisissez dépôt et administrateur) ou **restauration d'une sauvegarde**.

La connexion se fait en trois temps : dépôt → profil → PIN. Comptes de démonstration (affichés uniquement en mode démo) :
`Administrateur 1234`, `Sophie Martin 2345` (responsable), `Julie Laurent 4567` (opérateur).
**Passez en production** (Administration → Données) avant de saisir de vraies données : la démo est effacée et ses PIN disparaissent.

### Rôles

| Permission | Opérateur | Responsable | Administrateur |
|---|:-:|:-:|:-:|
| Entrées, sorties, transferts, réception, création de pièce | ✔ | ✔ | ✔ |
| Modifier / supprimer une pièce, corriger le stock, inventaire, import/export, étiquettes, emplacements, audit | | ✔ | ✔ |
| Utilisateurs, dépôts, sauvegarde/restauration, passage en production, tous les dépôts | | | ✔ |

Les droits sont vérifiés **dans la couche métier** (`js/core/ops.js`), pas seulement en masquant des boutons ; un opérateur
ou un responsable n'agit que sur son dépôt.

## Développer

```bash
npm install            # dépendances de test uniquement (Playwright, axe-core) ; l'application n'a aucune dépendance
npm run serve          # http://127.0.0.1:4173/spare-part/ (serveur statique de test, même sous-chemin que GitHub Pages)
npm run test:unit      # tests unitaires (node:test), sans navigateur
npm run test:e2e       # tests de bout en bout (Chromium via Playwright)
npm run sw             # régénère la liste de pré-cache de sw.js — OBLIGATOIRE après tout ajout/suppression de fichier
```

### Architecture

```
index.html              coquille : CSP stricte, sprite d'icônes, aucun script ni style en ligne
manifest.webmanifest    PWA (installation, raccourcis)         sw.js   hors-ligne (pré-cache versionné, mise à jour proposée)
css/                    tokens (clair/sombre) · base · components · views · print
js/core/                métier pur, sans DOM — testé en Node
  schema.js             modèle v5 + migrations (dont l'ancien format dior_v4, PIN en clair → hachés)
  store.js              stockage transactionnel : une opération réussit en entier ou ne change rien
  auth.js               PBKDF2-SHA256, politique de PIN, verrouillage progressif, permissions
  ops.js                TOUTES les mutations (stock, transferts, catalogue, utilisateurs, import, inventaire)
  queries.js            lectures pures (indicateurs, courbes, plan, réassort, recherche)
  ai.js                 analyse de photo (API Anthropic) · seed.js : données de démonstration relatives à la date du jour
js/lib/                 utilitaires purs : texte/échappement, CSV, EAN-13, QR, graphiques SVG, images
js/ui/                  routeur par hash, feuilles <dialog>, délégation d'événements, composants, session
js/ui/views/            un fichier par écran (login, home, scan, articles, plan, transferts, journal, inventaire, …)
vendor/ fonts/ icons/   bibliothèques, polices et icônes hébergées (aucun CDN) — scripts/vendor.js, scripts/icons.js
tests/unit/ tests/e2e/  voir ci-dessous
```

Conventions : bloc__élément--modificateur en CSS ; aucune interaction par attribut `onclick` — tout passe par
`data-action` / `data-change` / `data-submit` (`js/ui/dom.js`) ; tout HTML est produit par le gabarit `html` qui échappe
automatiquement (seul un `SafeHtml` peut être injecté) ; **toute mutation passe par `js/core/ops.js`** via `run()`.

### Tests

* **Unitaires** (136) : schéma et migrations, stockage transactionnel, authentification et verrouillage, chaque opération métier
  (limites, rôles, cloisonnement des dépôts, annulations), requêtes, CSV, EAN-13 et décodeur de repli (0 faux positif sur
  1 000 lignes de bruit), QR, graphiques, IA (assainissement, erreurs HTTP), **contrastes WCAG des jetons de design**,
  **cohérence PWA** (pré-cache = fichiers réels, graphe d'imports complet, manifeste, aucun CDN) et **règles statiques**
  (`tests/unit/lint.test.js` : imports inutiles, gestionnaires/styles en ligne, `innerHTML`, attributs non quotés, ARIA).
* **E2E** (≈ 55, Chromium mobile 390 px) : chaque écran, parcours de scan continu, fiche, inventaire signé avec PIN,
  administration (utilisateurs, import CSV avec aperçu, sauvegarde → restauration, production, effacement), sécurité
  (verrouillage après 5 PIN, inactivité, PIN hachés, CSP, aucune requête tierce), analyse photo (API simulée),
  **hors-ligne** et **mise à jour du service worker**, **accessibilité axe-core** (WCAG 2.1 A/AA, clair et sombre).
  Tout test échoue s'il produit une erreur JS, une violation de CSP ou une réponse HTTP ≥ 400 inattendue.
  `PW_PREFIX=/ npm run test:e2e` vérifie aussi que l'application fonctionne hors du sous-chemin `/spare-part/`.
  `SHOTS_DIR=/tmp/shots npx playwright test shots` produit des captures claires et sombres pour la revue visuelle.

## Données et sauvegarde

Tout est dans le `localStorage` du navigateur (clé `mode_stock_v5`). **Effacer les données du site, changer de navigateur
ou d'appareil fait perdre la base** : exportez régulièrement une sauvegarde JSON (Administration → Données ; un rappel
s'affiche sur l'accueil). La sauvegarde contient les empreintes de PIN : conservez-la comme un secret.
L'application demande un stockage persistant au navigateur, mais ce n'est jamais garanti (notamment sur iOS en navigation privée).
Les anciennes bases (`dior_v4`) sont migrées automatiquement, leurs PIN hachés puis la clé d'origine supprimée.

## Sécurité : ce qui est garanti, ce qui ne l'est pas

Mesures : CSP `script-src 'self'` (pas de script ni de gestionnaire en ligne, pas d'`eval`), aucune ressource tierce, rendu
auto-échappé (XSS), PIN hachés PBKDF2-SHA256 salés, verrouillage progressif (30 s → 15 min) et déconnexion après inactivité,
permissions vérifiées dans le métier, opérations transactionnelles, validation de toutes les entrées (CSV, sauvegardes, IA, images).

**Limites à connaître** — sans serveur :
* un PIN de 4 à 8 chiffres reste **devinable hors-ligne** par quelqu'un qui peut lire le `localStorage` de l'appareil
  (le hachage empêche la lecture directe et la réutilisation du PIN, le verrouillage protège contre l'essai manuel) ;
* un administrateur ou toute personne maîtrisant les outils du navigateur peut modifier la base ; le journal d'audit n'est donc **pas infalsifiable** ;
* chaque appareil a sa propre base : **pas de synchronisation** entre postes ni entre dépôts physiquement séparés.
Pour une garantie forte (comptes serveur, audit infalsifiable, synchronisation), il faut un backend — voir `docs/AUDIT.md` §6.

### Analyse de photo (IA)

Fonction facultative : chaque utilisateur saisit **sa propre clé API Anthropic** (enregistrée uniquement dans le navigateur,
envoyée uniquement à `api.anthropic.com`). Créez une clé dédiée avec une limite de dépense, et supprimez-la depuis l'écran
si l'appareil est partagé. La photo est réduite à 1 024 px avant envoi. Le modèle est défini à un seul endroit (`AI.model`
dans `js/core/ai.js`). Les codes-barres proposés par le modèle sont ignorés : les pièces importées reçoivent un code interne valide.

## Déployer / mettre à jour

1. Modifier le code, **`npm run sw`** (regénère le pré-cache et aligne la version sur `APP_VERSION` de `js/core/config.js`),
   puis `npm test`. Le test `pwa.test.js` échoue si la liste de pré-cache est périmée.
2. Incrémenter `APP_VERSION` pour toute modification livrée : les appareils reçoivent un bandeau « Mettre à jour »
   (jamais de rechargement imposé en pleine saisie) et conservent l'ancienne version jusqu'à validation.
3. Pousser sur la branche servie par GitHub Pages. Aucun build.

## Historique

Les anciennes pages `index-old.html` et `index2.html` (variante Dynamsoft) ont été retirées ; elles restent consultables dans
l'historique git (`git show b36ea99:index2.html`). Ce qu'`index2.html` apportait (flux de clé API, gardes anti-`null`, viewport
de scan agrandi) est repris dans la version actuelle — voir `docs/AUDIT.md`.
