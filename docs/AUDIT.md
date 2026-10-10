# Audit de MODE Stock (version 2 initiale)

Audit réalisé sur `index.html` (3 453 lignes, état de `main` après la PR #1), complété par
l'exécution réelle de l'application (captures mobiles 390 px, Chromium) et la comparaison
avec `index2.html` (variante Dynamsoft) et `index-old.html`.

Chaque constat est marqué : ✅ corrigé dans la refonte · 💡 proposition non réalisée (voir §6).

## 1. Fonctionnel

| # | Constat | Effet | Statut |
|---|---------|-------|--------|
| F1 | L'opération (entrée/sortie/transfert) est figée par le bouton d'accueil ; le « scanner libre » promet « Choisissez l'opération après détection » mais n'offre aucun choix | Obligation de repasser par l'accueil pour changer d'opération | ✅ sélecteur de mode dans l'écran de scan |
| F2 | Après chaque validation, retour automatique à l'accueil | Pas de scan en série (cas d'usage principal d'un entrepôt) | ✅ scan continu + récapitulatif de session |
| F3 | Aucune annulation d'une saisie erronée | Une mauvaise quantité impose une contre-opération manuelle | ✅ « Annuler » 8 s après chaque opération |
| F4 | Un transfert en attente ne peut être ni annulé ni refusé | Stock bloqué « en transit » indéfiniment | ✅ annuler (expéditeur) / refuser (destinataire) |
| F5 | « Entrées 30j », « Sorties 30j » et « Top opérateurs (30j) » ne filtrent pas sur 30 jours | Chiffres faux | ✅ filtre de période réel (7/30/90 j) |
| F6 | Historique plafonné à 500 lignes alors que la courbe « 30 jours » en dépend ; axe Y dégénéré quand la variation est faible (`1045, 1045, 1045, 1044, 1044`) | Courbe fausse ou plate | ✅ plafond relevé, axe calculé, courbe SVG |
| F7 | Plan : une seule colonne ⇒ cellules de ~440 px de haut ; « 100 % occupé » pour le rack alors que le global affiche 50 % | Écran inexploitable et incohérent | ✅ grille réelle, un seul calcul |
| F8 | Données de démo à dates absolues (mai) ; aujourd'hui = octobre | « 0 mouvement aujourd'hui », courbe plate | ✅ démo générée relativement à la date du jour |
| F9 | Catalogue et Stock = 2 listes + 3 fiches différentes pour le même article | Navigation et code dupliqués | ✅ une liste « Articles » + une fiche unifiée |
| F10 | Aucune sauvegarde/restauration alors que toute la donnée vit dans le navigateur | Perte totale si le stockage est purgé | ✅ export/import JSON validé + stockage persistant + rappel |
| F11 | Suppression d'un article/dépôt sans garde-fou sur le stock restant | Perte silencieuse de stock | ✅ refus si stock non nul |
| F12 | Rôles non appliqués : tout utilisateur peut corriger des stocks, supprimer des articles, appeler `showView('admin')` | Le rôle « opérateur » n'a aucune portée réelle | ✅ permissions vérifiées dans la couche métier |
| F13 | Recherche sensible aux accents (« bandouliere » ne trouve pas « Bandoulière ») | Résultats manqués | ✅ recherche insensible aux accents |
| F14 | Aucune navigation par historique : le retour Android quitte l'application | Perte de contexte | ✅ routage par hash + retour système |
| F15 | Pas de liste de réassort ni d'export | Réapprovisionnement manuel | ✅ « À réapprovisionner » + exports CSV |
| F16 | Pas de motif sur les sorties, pas d'étiquettes imprimables pour articles sans code-barres | Traçabilité faible | ✅ motifs + codes internes EAN-13 + étiquettes |

## 2. Ergonomie et design

| # | Constat | Statut |
|---|---------|--------|
| U1 | Libellés à 8 px, majuscules espacées ; onglets inactifs `#c8c4bc` sur blanc = 1,74:1, libellés `#8c8880` = 3,53:1, placeholders `#eeede9` = 1,17:1 (seuil WCAG AA : 4,5:1) | ✅ échelle typographique ≥ 12 px, contrastes ≥ 4,5:1 vérifiés par axe-core |
| U2 | `user-scalable=no` interdit le zoom (WCAG 1.4.4) ; il masquait le zoom automatique d'iOS sur les champs < 16 px | ✅ zoom autorisé, champs à 16 px |
| U3 | Bouton « MENU » qui déborde de son cadre ; « MVTS AUJOURD'HUI » tronqué | ✅ |
| U4 | Emojis (📦 📍) utilisés comme icônes : rendu différent selon la plateforme | ✅ jeu d'icônes SVG unique |
| U5 | Zones tactiles < 44 px (nav, chips) ; viewport de scan de 220 px | ✅ cibles ≥ 44 px, viewport de scan agrandi (repris d'`index2.html`) |
| U6 | Connexion : saisie du nom au clavier + choix du dépôt + PIN ; les comptes de démo et leurs PIN sont affichés en clair | ✅ choix du profil + clavier PIN, aide de démo uniquement en mode démo |
| U7 | Pas de thème sombre, pas de `prefers-reduced-motion`, focus clavier invisible, pas de rôles ARIA ni de piège de focus dans les fiches | ✅ |
| U8 | Écran « Scanner » vide sous le viewport ; aucune aide contextuelle | ✅ carte de résultat, emplacement conseillé, présélections de quantité |

## 3. Code

- **Monolithe** : un fichier de 3 453 lignes mêlant CSS, HTML, 34 Ko de JSON de démo en littéral et toute la logique ; état global mutable (`db`, `S`, `cur*`).
- **130 gestionnaires en ligne** (119 `onclick`, 11 `oninput`/`onchange`/`onkeydown`) : empêchent toute politique CSP stricte.
- **Duplication** : 3 rendus de ligne d'historique identiques, 4 comparateurs de tri par emplacement, `buildLocCode(l.rack,l.allee,l.etagere,l.case)` recopié 24 fois.
- **Code mort / vestiges** : `checkPending`, `isIOS` partiel, conteneur `dce-view-container` (Dynamsoft), commentaires « BELOW THIS is the rest of the ORIGINAL function ».
- **Aucun test dans le dépôt** (les tests de la PR #1 vivaient hors dépôt).
- **PWA cassée** : le service worker est enregistré depuis une URL `blob:`, refusée par les navigateurs (`Failed to register a ServiceWorker: The URL protocol of the script ('blob:…') is not supported`, vérifié à l'exécution, erreur avalée par un `.catch(console.log)`). Le mode hors-ligne n'a donc jamais fonctionné. Le manifeste est une URI `data:`.
- **Dépendances externes** : `html5-qrcode` et `qrcode-generator` chargés depuis unpkg sans SRI et non mis en cache (scanner inutilisable hors-ligne) ; polices Google Fonts (dépendance réseau + RGPD).

## 4. Sécurité

| # | Constat | Statut |
|---|---------|--------|
| S1 | PIN stockés et comparés **en clair** ; PIN de démo codés en dur et affichés sur l'écran de connexion | ✅ PBKDF2-SHA256 salé, migration automatique des anciens PIN |
| S2 | Aucune limite d'essais, aucun verrouillage d'inactivité | ✅ verrouillage progressif + déconnexion automatique |
| S3 | Aucune CSP ; scripts et handlers en ligne | ✅ CSP `script-src 'self'`, zéro handler en ligne, rendu par gabarit auto-échappant |
| S4 | Libs tierces sans SRI | ✅ libs hébergées dans le dépôt (plus de CDN) |
| S5 | Photos envoyées à l'IA non redimensionnées (limite API 5 Mo/image → échecs fréquents avec un téléphone) ; photos d'articles stockées en base64 pleine taille (quota 5 Mo) | ✅ redimensionnement/compression |
| S6 | Clé API Anthropic en clair dans `localStorage` | ⚠️ inhérent à une app sans serveur ; réduit par la CSP, avertissement explicite, clé supprimée sur 401 ; 💡 proxy serveur |
| S7 | Écritures multi-onglets : dernier écrivain gagnant | ✅ synchronisation par événement `storage` |
| S8 | Pas de rollback si une opération échoue en cours de route | ✅ validation avant mutation + rechargement depuis le stockage en cas d'erreur |

**Limite structurelle (à connaître)** : sans serveur, un PIN de 4 à 8 chiffres reste devinable hors-ligne par quelqu'un qui
aurait accès au `localStorage` de l'appareil. Le hachage supprime l'exposition en clair (et la réutilisation du PIN ailleurs),
le verrouillage protège contre l'essai manuel, mais seule une authentification côté serveur donne une garantie forte.

## 5. Ce qu'`index2.html` apportait (repris)

`index2.html` n'est pas un doublon : c'est la variante Dynamsoft, avec trois apports conservés dans la refonte :
le flux de clé API (clé `mode_anthropic_api_key`, vérification du préfixe `sk-ant-`, effacement sur 401), les gardes anti-`null`,
et le viewport de scan agrandi (75 vh, sticky). La clé déjà enregistrée sous `mode_anthropic_api_key` reste donc valable.

## 6. Propositions non réalisées (décision ou infrastructure requise)

1. **Backend + authentification réelle** (Supabase/Firebase/API maison) : synchronisation multi-appareils temps réel, comptes et PIN côté serveur, journal d'audit infalsifiable. C'est la seule voie pour une sécurité forte.
2. **Proxy serveur pour l'IA** : ne plus exposer de clé API dans le navigateur.
3. **Lots / dates de péremption**, **fournisseurs et bons de commande**, **imprimantes d'étiquettes** (ZPL/Bluetooth), **notifications** d'alerte (nécessite un serveur de push).
4. **Photos dans IndexedDB** si le catalogue dépasse quelques centaines d'articles illustrés.
