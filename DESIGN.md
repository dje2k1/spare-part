# Système de design — « Plaques & lignes » (v3.2)

**Thèse.** Le réseau de stock de la maison parle la langue de la signalétique parisienne. Chaque lieu — entrepôt
central, atelier, rayonnage, emplacement — est une **plaque émaillée** : aplat sans dégradé, liseré blanc intérieur.
Chaque flux — commande, livraison, transfert, historique — est une **ligne de métro** : rail, stations, cocardes.

C'est une interface de travail (mode « opérer ») : on la lit d'un coup d'œil, avec des gants, sous les néons d'un
entrepôt ou la lumière d'un atelier. La marque vit dans des détails précis et constants, pas dans des effets.

## Couleurs

Toutes les valeurs sont dans `css/tokens.css`. Les contrastes sont **calculés par les tests**
(`tests/unit/design-tokens.test.js`) : texte ≥ 4,5:1, éléments d'interface ≥ 3:1, dans les deux thèmes.

### Surfaces et texte

| Jeton | Clair | Sombre (« la rue la nuit ») | Usage |
|---|---|---|---|
| `--bg` | `#eef1f7` porcelaine | `#0a0f1f` marine | fond de page |
| `--bg-soft` / `--bg-sunken` | `#e6eaf3` / `#dde2ee` | `#0f152a` / `#151c35` | survols, pistes, segmentés |
| `--surface` | `#ffffff` | `#121933` | cartes, listes, feuilles |
| `--ink` / `--ink-2` / `--ink-3` | `#0f1631` / `#3b4563` / `#545e7c` | `#f1f4fb` / `#c3cbdf` / `#9aa4bf` | texte principal, secondaire, discret |
| `--line` / `--line-strong` | `#dbe0eb` / `#c2c9da` | `#222a46` / `#333e63` | filets, rails neutres |
| `--control` | `#7a83a0` | `#7d88a8` | bordure des champs (≥ 3:1) |

États (texte, puis fond teinté) : `--red` `#b02a17`, `--green` `#0b6346`, `--amber` `#7d5500`, `--blue` `#1b3d93`
(clair) — versions éclaircies en sombre. Jamais de gris sur une couleur : sur un aplat, le texte prend `--f-on`.

### Émaux des sections

Une section porte un émail (`body[data-accent]`), un élément peut en porter un autre (`.fam-…`). Chaque émail fournit
`--f` (aplat), `--f-on` (texte et liseré posés dessus), `--f-text` (accent sur fond clair, version lumineuse en sombre)
et `--f-soft` (teinte douce).

| Famille | Émail | Texte posé | Sections |
|---|---|---|---|
| `brand`, `indigo` | bleu émail `#1b3d93` | blanc | accueil, connexion, articles, tableau de bord, recherche |
| `blue` | azur `#0b5cad` | blanc | commandes, transferts, préparation, scan transfert |
| `teal` | bleu canard `#0b6b74` | blanc | plan, étiquettes |
| `green` | vert `#0d6b4c` | blanc | réception, scan entrée |
| `amber` | safran `#f3b41b` | **encre** `#0f1631` | panier, achats, fournisseurs, inventaire |
| `red` | vermillon `#c7361f` | blanc | scan sortie, réassort |
| `violet` | violine `#6a2d8f` | blanc | seuils, rapport |
| `slate` | encre `#2b3555` | blanc | journal, administration |
| `rose` | framboise `#b52a63` | blanc | analyse photo |

La barre d'état du téléphone suit l'émail (`js/ui/look.js`, table `TOP`, identique aux aplats).

### Lignes de dépôt et monogrammes

Dix émaux sûrs (`.hue-0` … `.hue-9`, variable `--h`, texte blanc ≥ 4,5:1) pour les initiales des pièces, les avatars et
la **couleur de ligne de chaque dépôt** : l'entrepôt central porte le bleu émail, chaque atelier une autre teinte stable
(`depotHue()` dans `js/ui/look.js`) — la même à la connexion et sur la ligne des commandes de l'accueil.

## Typographie

Une seule famille, **Archivo variable** (OFL, auto-hébergée : `fonts/archivo-variable.woff2`, 90 Ko), axes graisse
100–900 et chasse 62–125 %.

| Rôle | Réglage |
|---|---|
| Plaques (en-têtes de page, accueil, plaques d'action) | 800, chasse 66–70 %, capitales, interlignage 0,92–1 |
| Titres de section (cartes, menu, « Aujourd'hui ») | 800, chasse 70 %, capitales, +0,03 à +0,08 em |
| Chiffres (stocks, indicateurs, quantités) | 800, chasse 76 %, chiffres tabulaires |
| Titres d'objets (nom de pièce, feuille) | 750, chasse 92 %, casse normale |
| Texte, libellés de champs | 400–650, chasse 100 %, casse normale |
| Boutons | 800, chasse 84 %, capitales, +0,04 em |

Échelle fixe (rem) : 12 · 13 · 15 · 16 (champs, évite le zoom iOS) · 18 · 22 · 28 · 38 · 48. Pas de sur-titre au-dessus
d'un titre : un titre parle seul ; une catégorie se place après lui.

## Formes et élévation

* Rayons : petite plaque 6 px (emplacement, état) · contrôle 12 px · plaque et carte 14 px · feuille 20 px · pastille
  ronde réservée aux petits contrôles (puces).
* Liseré des plaques : 2 px, blanc (ou encre sur le safran), à 5–10 px du bord.
* Élévation déclarée **une fois** : ombre décalée et floue, teintée d'encre (`--shadow-1/2/3`) — jamais bordure + ombre.

## Vocabulaire

| Élément | Où | Classe |
|---|---|---|
| Plaque | en-tête de chaque page, plaque du dépôt sur l'accueil, plaques d'action, stock sur la fiche de scan, en-tête du menu | `.page-head`, `.hero__plaque`, `.tile`, `.scan-card__stock`, `.drawer__head` |
| Plaque d'emplacement | partout où un emplacement s'affiche ; toujours bleu émail | `.loc`, `.pick-loc`, `.scan-card__loc strong` |
| Petite plaque d'état | Épuisé, Alerte, Expédiée… | `.pill--zero/low/ok/info` |
| Cocarde | avatars, pictogrammes du menu et de l'administration, bouton de scan, compteurs | `.avatar`, `.menu-item > .i`, `.tabbar__fab`, `.tile__count` |
| Station et rail | ligne des commandes, trajets des transferts, historique des mouvements, étapes d'une commande, « Aujourd'hui », dépôts à la connexion | `.ligne`, `.tr-card__rail`, `.row__bar`, `.timeline`, `.today__list`, `.login__ico` |

**La ligne des commandes** (accueil) : quatre stations — commande, préparation, expédition, arrivée. Chaque état en
cours occupe le milieu d'un tronçon et y pose un « train » (la commande la plus ancienne, plus le nombre des suivantes) :
en attente, en préparation, en route. Vue de l'entrepôt central, la même ligne montre les commandes des ateliers.

## Mouvement

* Le mouvement dit un changement d'état, jamais une décoration : 150–250 ms, sortie exponentielle
  (`--ease-out`), aucun rebond, rien en boucle (hors indicateurs de chargement et ligne de visée de la caméra).
* Le seul moment signé : à l'arrivée sur l'accueil, les commandes **roulent** jusqu'à leur tronçon (700 ms).
* L'écran arrive en 220 ms ; les feuilles, menus et notifications glissent en 220–320 ms.
* `prefers-reduced-motion` : tout s'arrête.

## Accessibilité et surfaces du navigateur

* Contrastes vérifiés par calcul (jetons) **et** par axe-core sur chaque écran, en clair et en sombre (`tests/e2e/a11y.spec.js`).
* Focus clavier : anneau de 3 px à la couleur d'accent, blanc (ou encre) sur les aplats.
* Sélection de texte, curseur, barres de défilement, soulignements et chiffres tabulaires sont thématisés.
* Cibles tactiles ≥ 48 px ; champs à 16 px.

## Ce que la charte refuse

Dégradés décoratifs et texte en dégradé, verre dépoli, halos colorés sans décalage, bordures latérales colorées sur les
cartes et alertes, sur-titres en capitales au-dessus des titres, anneaux de progression et blobs flottants, emoji en
guise d'icônes, police d'affichage dans les libellés et les données, animations en boucle.

## Fichiers

`css/tokens.css` (jetons, émaux, teintes) · `css/base.css` (typographie, focus, mouvement) · `css/components.css`
(boutons, champs, plaques, listes, barres, dialogues) · `css/views.css` (écrans) · `css/work.css` (accueil, travail
magasinier) · `css/print.css` (impression, même identité en noir sur blanc) · `scripts/icons.js` (icônes PWA : la
plaque « M ») · `js/ui/look.js` (émail par section, couleurs de dépôt).
