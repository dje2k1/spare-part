# MODE — Gestion de stock

Application de gestion de pièces détachées pour un **entrepôt central qui approvisionne des ateliers** : scan de
codes-barres, sorties et réceptions, commandes des ateliers au central (préparation, expédition, reliquats, réception avec
écarts), commandes fournisseurs, seuils intelligents, étiquettes, inventaire guidé, briefing quotidien et rapport hebdomadaire.
PWA mobile d'abord (iPhone et Android), utilisable hors ligne, thème clair / sombre, aucune compilation.

> Version 3.3 · pensée pour les magasiniers : un accueil simple à quatre plaques d'action, les fonctions avancées dans
> le menu ; fluide sur un vrai catalogue (des milliers de pièces, des centaines de commandes). Charte graphique
> « Plaques & lignes » : la signalétique parisienne appliquée au stock ([système de design](DESIGN.md)).

## Deux façons de l'utiliser

| | **Mode serveur** (plusieurs sites) | **Mode autonome** |
|---|---|---|
| Pour | Entrepôt + ateliers physiquement séparés, ~100 utilisateurs | Un seul poste ou un essai |
| Données | Une base commune sur le serveur de l'entreprise, copie locale sur chaque appareil | Sur l'appareil uniquement |
| Synchronisation | Temps réel entre tous les appareils ; saisie hors ligne envoyée au retour du réseau | Aucune |
| Connexion | Code d'accès de l'entreprise (une fois par appareil) puis PIN vérifié par le serveur | PIN vérifié sur l'appareil |
| Analyse photo | Clé API sur le serveur, quota par compte | Clé personnelle saisie sur l'appareil |
| Hébergement | Docker + HTTPS (Caddy inclus) : **[guide de déploiement](docs/DEPLOIEMENT.md)** | GitHub Pages ou tout hébergement statique |

Le mode est détecté tout seul : servie par le serveur de synchronisation, la page passe en mode serveur ; servie en
statique, elle reste autonome. Le même code métier (`js/core/`) s'exécute sur les appareils **et** sur le serveur.

Essai rapide du mode serveur : `npm ci --prefix server && npm run server:demo` puis `http://127.0.0.1:8080`
(code d'accès `DEMO`). Comptes de démonstration (PIN affichés à la connexion) : `Administrateur 1234`,
`Sophie Martin 2345` (responsable, Paris), `Julie Laurent 4567` (opératrice, Paris), `Karim Benali 2468` (responsable, entrepôt),
`Léa Moreau 1357` (opératrice, entrepôt). **Passez en production** (Administration → Données) avant de saisir de vraies données.

## Pour les magasiniers

* **Accueil** : la plaque du dépôt (« vous êtes ici ») avec trois chiffres (stock sain, alertes, à recevoir ou à
  préparer), une barre « scanner ou chercher » (douchette, clavier ou caméra), la **ligne des commandes en cours** —
  chaque commande est posée sur le tronçon de son état réel (en attente, en préparation, en route) entre l'entrepôt
  central et l'atelier — puis quatre plaques d'action selon le site — atelier : *Réceptionner*, *Sortir*, *Commander*,
  *Inventaire* (ou *Entrée* pour un opérateur) ; entrepôt : *Préparer*, *Réceptionner*, *Sortir*, *Commander* (ou
  *Entrée*) — avec leurs compteurs, et la liste « Aujourd'hui » (livraisons attendues, alertes, commandes à préparer).
* **Gestes** : chaque écran de travail se pilote au scan (contrôle de la pièce, quantité, retour sonore et vibration),
  avec annulation immédiate ; aucune action n'est perdue par un double appui.
* **Douchette** (lecteur Bluetooth/USB en mode clavier) : utilisable partout, même si un champ quantité a le focus — la
  rafale est reconnue, le champ retrouve sa valeur et le code est traité comme un scan. Les écritures d'un même code
  (UPC-A sur 12 chiffres, EAN-13, GTIN-14) retrouvent la même pièce : pas de doublon créé.
* **Sortie, entrée, transfert** : stock disponible rappelé, bouton « Tout (N) », dépassement signalé avant validation ;
  l'historique de la session de scan permet d'annuler une saisie même après la disparition du message (15 min ; un
  transfert tant qu'il n'est pas reçu).
* **Inventaire guidé** : comptage au scan (chaque lecture ajoute 1, à la douchette ou à la caméra), ou à la main.
* **Menu** (bouton en haut à droite) : articles, transferts, plan, inventaire, étiquettes, commandes fournisseurs,
  fournisseurs, seuils intelligents, réassort, rapport, tableau de bord, journal, analyse photo, administration.
* **Votre journée** : à la première ouverture du jour, un résumé (ce qui arrive, ce qui manque, ce qui attend).
* **Repères visuels** : chaque section porte un émail, comme une ligne de métro (barre du haut, plaque d'en-tête,
  boutons, liens) — réception en vert, sortie en vermillon, flux en azur, achats et inventaire en safran… ; les
  emplacements s'affichent comme des plaques de rue bleues (« R1-A2-E2-C1 »), les historiques comme des lignes à
  stations. Les chiffres sont grands et étroits, lisibles d'un coup d'œil. À l'ouverture de l'accueil, les commandes
  roulent jusqu'à leur tronçon ; rien ne bouge si le téléphone est réglé sur « réduire les animations » ; clair et
  sombre au choix.
* **Connexion** : dépôt → nom → PIN ; au-delà de 8 personnes sur un site, un champ filtre la liste des profils.

### Rôles

| Permission | Opérateur | Responsable | Administrateur |
|---|:-:|:-:|:-:|
| Sorties, réceptions, transferts, commandes au central, préparation (entrepôt), étiquettes, création de pièce | ✔ | ✔ | ✔ |
| Corriger le stock, inventaire, catalogue, import/export, emplacements, audit, commandes fournisseurs, fournisseurs, seuils, rapports, analyse photo | | ✔ | ✔ |
| Utilisateurs, dépôts, sauvegarde/restauration, réglages, passage en production, tous les dépôts | | | ✔ |

Les droits sont vérifiés **dans la couche métier** (`js/core/ops*.js`), pas seulement en masquant des boutons — et en mode
serveur, par le serveur avec l'identité de la session. Un opérateur ou un responsable n'agit que sur son dépôt.

## Développer

```bash
npm install                 # outils de test (Playwright, axe-core) ; l'application n'a aucune dépendance
npm ci --prefix server      # serveur : une seule dépendance (SDK Anthropic, pour le relais photo)
npm run serve               # mode autonome : http://127.0.0.1:4173/spare-part/ (même sous-chemin que GitHub Pages)
npm run server:demo         # mode serveur avec données de démonstration : http://127.0.0.1:8080 (code DEMO)
npm run test:unit           # tests unitaires (node:test), sans navigateur
npm run test:server         # serveur : journal, API, sécurité, temps réel, moteur de synchronisation, relais IA
npm run test:e2e            # bout en bout (Chromium via Playwright), modes autonome ET serveur
npm run sw                  # régénère la liste de pré-cache de sw.js — OBLIGATOIRE après tout ajout/suppression de fichier
```

### Architecture

```
index.html              coquille : CSP stricte, sprite d'icônes, aucun script ni style en ligne ; meta « mode-sync »
manifest.webmanifest    PWA          sw.js   hors-ligne (pré-cache versionné, mise à jour proposée, API jamais en cache)
css/                    tokens (clair/sombre) · base · components · views · work (écrans de travail) · print (étiquettes)
js/core/                métier pur, sans DOM — exécuté sur les appareils ET sur le serveur, testé en Node
  schema.js             modèle v6 (entrepôt central / ateliers, fournisseurs, commandes, seuils par dépôt) + migrations
  ops.js ops-orders.js  TOUTES les mutations (stock, transferts, catalogue, comptes, commandes, achats, seuils)
  ops-kit.js            garde-fous communs (identifiants déterministes, journalisation, consommation hebdomadaire)
  registry.js           nom stable de chaque opération (ce qui circule entre appareils et serveur)
  recorder.js           exécution transactionnelle avec enregistrement du delta (diffusion) et retour arrière total
  sync-engine.js        appareil en mode serveur : exécution anticipée, file hors ligne, rebasage sur les événements
  planning.js           seuils intelligents, prévisions de rupture, préparation, achats, briefing, rapport
  queries.js auth.js ai.js store.js seed.js   lectures · PIN et droits · analyse photo · stockage local · démonstration
js/lib/                 texte/échappement, CSV, EAN-13, QR, graphiques SVG, images, étiquettes (planches A4, ZPL)
js/ui/                  routeur, feuilles <dialog>, délégation d'événements, session, codebar (douchette/caméra),
                        sync-ui (mode serveur : connexion, flux temps réel, état), net.js, idb.js (copie locale)
js/ui/views/            un fichier par écran
server/                 serveur de synchronisation (node:http, sans framework)
  sync-store.js         base qui fait foi : journal d'événements fsync, instantanés, rejeu, doublons, diffusion
  auth.js app.js        code d'accès, PIN, sessions, limites · API, flux SSE, fichiers, en-têtes de sécurité
  ai.js index.js        relais d'analyse photo (SDK Anthropic) · configuration par variables d'environnement
Dockerfile docker-compose.yml Caddyfile .env.example   déploiement (voir docs/DEPLOIEMENT.md)
tests/unit/ tests/server/ tests/e2e/
```

Conventions : bloc__élément--modificateur en CSS ; aucune interaction par attribut `onclick` — tout passe par
`data-action` / `data-change` / `data-submit` (`js/ui/dom.js`) ; tout HTML est produit par le gabarit `html` qui échappe
automatiquement ; **toute mutation passe par une opération du registre** via `run()` (locale, ou envoyée au serveur).

### Tests

* **Unitaires** (≈ 195) : schéma et migrations, stockage transactionnel, PIN (politique par rôle, coût de l'empreinte) et
  verrouillage, chaque opération métier (limites, rôles, cloisonnement, commandes, reliquats, achats), enregistreur de
  deltas (retour arrière, application à une copie), seuils intelligents et prévisions, indicateurs, étiquettes, CSV,
  EAN-13 et codes équivalents, QR, IA, contrastes WCAG, cohérence PWA (empreinte du cache), règles statiques (syntaxe
  de tous les modules, imports inutiles, `innerHTML`, gestionnaires en ligne, ARIA), **montée en charge** (3 000 pièces,
  1 200 commandes : chaque écran sous budget), bibliothèques embarquées identiques aux paquets npm, durcissement du
  déploiement (Compose, Caddy, image).
* **Serveur** (≈ 60, contre le vrai serveur) : journal (doublons, refus sans effet, identité imposée, reprise après arrêt
  brutal et ligne tronquée, journal corrompu refusé, archivage), API (code d'accès, verrouillage, cookie `HttpOnly`, CSRF,
  jetons forgés, cookie mal encodé, révocation, purge des sessions, sauvegarde/restauration, sauvegardes quotidiennes,
  fichiers non servis, compression, en-têtes), temps réel (SSE, `Last-Event-ID`),
  **moteur de synchronisation** (deux appareils, hors ligne avec redémarrage, conflit entre sites, réponse perdue,
  session expirée, divergence détectée et corrigée), relais IA (API Anthropic simulée, quota, erreurs), **sécurité**
  (adresse derrière le proxy, opérations réservées au serveur, changement de PIN, journal d'audit filtré et archivé,
  limites de ressources, configuration refusée au démarrage — chaque test vérifié en réintroduisant la faille).
* **E2E** (≈ 90, Chromium mobile 390 px) : tous les écrans et parcours, douchette (y compris dans un champ), comptage
  d'inventaire au scan, historique de session, sécurité, hors-ligne, mise à jour du service
  worker, accessibilité axe-core (WCAG 2.1 A/AA, clair et sombre) ; **mode serveur** avec un vrai serveur par test :
  appareil neuf, temps réel entre deux navigateurs, saisie hors ligne puis envoi, application rouverte sans réseau,
  conflit signalé, compte supprimé, changement de PIN vérifié par le serveur, analyse photo relayée. Tout test échoue
  sur une erreur JS, une violation de CSP ou une réponse HTTP ≥ 400 inattendue.

## Données et sauvegarde

* **Mode serveur** : la base fait foi sur le serveur (journal écrit sur disque avant chaque réponse + instantanés).
  Une sauvegarde complète est faite **chaque jour** sur le serveur (14 jours conservés, téléchargeables depuis
  Administration → Données) ; en plus : *Télécharger la sauvegarde du serveur* et sauvegarde du volume Docker
  ([guide](docs/DEPLOIEMENT.md#6-sauvegardes)). Les commandes soldées et transferts terminés depuis plus de 13 mois
  sont archivés sur le serveur : la base envoyée aux appareils reste légère. Chaque appareil garde une copie locale
  (IndexedDB) pour le hors-ligne.
* **Mode autonome** : tout est dans le navigateur (`localStorage`) ; **effacer les données du site ou changer d'appareil fait
  perdre la base** : exportez régulièrement une sauvegarde (un rappel s'affiche).

Les sauvegardes contiennent les empreintes de PIN : conservez-les comme un secret. Les anciennes bases (v4, v5) sont migrées automatiquement.

## Sécurité

Partout : CSP `script-src 'self'` (aucun script en ligne, aucun `eval`, aucune ressource tierce), rendu auto-échappé,
PIN hachés PBKDF2-SHA256 salés, verrouillage progressif (30 s → 15 min), verrouillage après inactivité, permissions
vérifiées dans le métier, opérations transactionnelles, validation de toutes les entrées (CSV, sauvegardes, IA, images).

En **mode serveur** en plus : code d'accès de l'entreprise (8 caractères minimum), PIN vérifiés par le serveur avec
verrouillage par compte (journalisé) et limitation par adresse, PIN de 6 chiffres pour les administrateurs, changement de
PIN vérifié par le serveur, session en cookie `HttpOnly` / `SameSite=Strict` / `Secure` (empreinte seule côté serveur),
protection CSRF, chaque opération réexécutée par le serveur avec l'identité de la session, **aucune empreinte de PIN
envoyée aux appareils** (vérificateur hors ligne fabriqué sur l'appareil, 12 h, effacé à la déconnexion), journal d'audit
réservé aux responsables et administrateurs, jamais tronqué ni falsifiable depuis un appareil, ressources bornées (flux,
calculs, débit d'opérations, sessions), conteneur en lecture seule sans privilège, clé Anthropic uniquement sur le
serveur. Audit de sécurité, correctifs et risques résiduels : [AUDIT.md, passe 5](docs/AUDIT.md#passe-5--audit-de-sécurité-version-33) ;
exploitation : [guide de déploiement §8](docs/DEPLOIEMENT.md#8-sécurité).

**Limites du mode autonome** : un PIN court reste devinable hors ligne par qui lit le stockage de l'appareil, la base et
le journal sont modifiables avec les outils du navigateur, et chaque appareil a sa propre base (pas de synchronisation).
Sur GitHub Pages, tous les sites d'un même compte partagent l'origine `<compte>.github.io` (donc le stockage) : pour de
vraies données, préférez le mode serveur ou un domaine dédié.

### Analyse de photo (IA)

Fonction facultative (responsables) : la photo d'un produit est analysée par l'API Claude, qui propose ses pièces détachées
probables, à importer au catalogue. Mode serveur : la clé est sur le serveur (`ANTHROPIC_API_KEY`), quota par compte.
Mode autonome : chaque utilisateur saisit sa propre clé (stockée dans le navigateur, envoyée uniquement à `api.anthropic.com`).
La photo est réduite à 1 024 px avant envoi ; le modèle est défini à un seul endroit (`AI.model`, `js/core/ai.js`) ; les
codes-barres proposés par le modèle sont ignorés (codes internes attribués).

## Déployer / mettre à jour

1. Modifier le code, **`npm run sw`**, puis `npm test`. `pwa.test.js` échoue si la liste de pré-cache ou l'empreinte
   du contenu sont périmées : la version du cache (`sw.js`) intègre une empreinte de tous les fichiers servis, si bien
   que chaque livraison renouvelle le cache des appareils, même sans changement de numéro de version.
2. Incrémenter `APP_VERSION` (`js/core/config.js`) pour toute livraison notable (numéro affiché) : les appareils
   reçoivent un bandeau « Mettre à jour », jamais de rechargement imposé en pleine saisie.
3. Mode serveur : `git pull && docker compose up -d --build` sur le serveur. Mode autonome : pousser sur la branche servie
   par GitHub Pages.

## Historique

Version 3.3 : audit de sécurité complet ([constats, correctifs et risques résiduels](docs/AUDIT.md#passe-5--audit-de-sécurité-version-33)) —
adresse réelle derrière le proxy (limitation des essais incontournable), code d'accès de 8 caractères minimum, changement
de PIN vérifié par le serveur, plus aucune empreinte de PIN envoyée aux appareils, journal d'audit réservé et archivé au
lieu d'être tronqué, verrouillages journalisés, ressources du serveur bornées, PIN de 6 chiffres pour les administrateurs,
conteneurs durcis, bibliothèques embarquées vérifiées octet pour octet ; chaque correctif a son test.
Version 3.2 : nouvelle charte graphique « Plaques & lignes » ([système de design](DESIGN.md)) — police unique
Archivo variable (étroite pour la signalétique), émaux par section aux contrastes vérifiés par les tests, plaques et
lignes de métro (ligne des commandes en cours sur l'accueil, trajets des transferts, historiques à stations), icônes
et impression assorties, plus aucun effet décoratif en boucle.
Version 3.1 : passe complète d'audit ([constats et corrections](docs/AUDIT.md#passe-4--version-31)) — calculs indexés
(accueil 70 fois plus rapide sur un gros catalogue), douchette robuste, comptage d'inventaire au scan, historique de
session avec annulation, codes équivalents, indicateurs justes pour les ateliers et l'entrepôt, cache hors ligne toujours
renouvelé, sauvegardes quotidiennes et archivage côté serveur, fichiers compressés.
Version 3 : entrepôt central et ateliers, commandes internes et fournisseurs, seuils intelligents, étiquettes thermiques et
bureautiques, briefing et rapport, serveur de synchronisation et relais IA, nouvel accueil magasinier. Version 2 : refonte
modulaire (PWA hors-ligne, tests, sécurité) — voir `docs/AUDIT.md`. Les anciennes pages `index-old.html` et `index2.html`
restent consultables dans l'historique git.
