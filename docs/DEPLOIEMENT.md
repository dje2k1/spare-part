# Déployer MODE Stock pour plusieurs sites (mode serveur)

Ce guide met en service le **serveur de synchronisation** : une seule base pour l'entrepôt central et tous les ateliers,
mise à jour en temps réel sur chaque téléphone, avec saisie possible hors ligne. Prévu pour une centaine d'utilisateurs
répartis sur une dizaine de sites physiquement séparés.

> Sans serveur, l'application fonctionne aussi en **mode autonome** (GitHub Pages, données sur chaque appareil, aucune
> synchronisation). Le mode serveur est indispensable dès que plusieurs sites partagent le même stock.

## 1. Ce qu'il faut

| Besoin | Recommandation |
|---|---|
| Serveur | Un petit serveur Linux (VPS) : 2 vCPU, 2 à 4 Go de RAM, 20 Go de disque. Exemples : OVHcloud, Scaleway, Hetzner, ou une machine interne joignable des sites. |
| Logiciels | Docker et Docker Compose. Rien d'autre (aucune base de données externe). |
| Nom de domaine | Un sous-domaine, ex. `stock.votre-entreprise.fr`, pointé (enregistrement DNS A/AAAA) vers le serveur. |
| HTTPS | **Obligatoire** : caméra, installation sur l'écran d'accueil et hors-ligne ne fonctionnent qu'en HTTPS. Fourni automatiquement par Caddy (inclus). |
| Ports ouverts | 80 et 443 (entrants). |
| Clé API Anthropic | Facultative, pour l'analyse photo. Elle reste sur le serveur. |

## 2. Installation

```bash
git clone https://github.com/<compte>/spare-part.git && cd spare-part
cp .env.example .env
nano .env        # DOMAIN, ORG_CODE, BOOTSTRAP_ADMIN_NAME / BOOTSTRAP_ADMIN_PIN, (ANTHROPIC_API_KEY)
docker compose up -d --build
docker compose logs -f mode-stock    # « serveur prêt » ; Ctrl+C pour quitter les journaux
```

Ouvrez `https://<DOMAIN>` : l'écran demande le **code d'accès** (`ORG_CODE`), puis connectez-vous avec l'administrateur
initial. Les variables `BOOTSTRAP_*` ne servent qu'à la première installation : une fois des données présentes, elles sont ignorées.

Pour essayer avant de saisir de vraies données : `DEMO=1` dans `.env` (entrepôt, 3 ateliers, 7 comptes, 16 semaines
d'activité simulée ; les PIN d'essai sont affichés à la connexion). Ensuite, *Administration → Données → Passer en
production* efface la démo **sur le serveur** et repart d'un entrepôt central vide avec votre administrateur ; retirez `DEMO=1`.

## 3. Mise en route des sites

1. **Dépôts** (Administration → Dépôts) : l'entrepôt central existe ; créez un dépôt de type *Atelier* par site.
2. **Comptes** (Administration → Utilisateurs) : un compte par personne, avec son rôle et son dépôt, et un PIN de 4 à 8 chiffres.
   Opérateur : sorties, réceptions, commandes au central, préparation (à l'entrepôt). Responsable : en plus, stock, seuils,
   commandes fournisseurs, rapports. Administrateur : tout, tous les dépôts.
3. **Catalogue** : import CSV (Administration → Import, modèle téléchargeable), puis emplacements et étiquettes.
4. **Seuils** : *Menu → Seuils intelligents* propose des seuils par dépôt à partir de la consommation (après quelques semaines).
5. **Communiquer** l'adresse et le code d'accès aux équipes.

### Installer sur les téléphones

* **iPhone (Safari)** : ouvrir l'adresse → bouton Partager → *Sur l'écran d'accueil*.
* **Android (Chrome)** : ouvrir l'adresse → menu ⋮ → *Installer l'application* (ou bandeau proposé).
* Premier lancement : code d'accès (une seule fois par appareil), puis dépôt → nom → PIN.
* Un appareil partagé (tablette d'atelier) convient : chacun se connecte avec son PIN ; le verrouillage après inactivité
  se règle dans Administration → Données.

## 4. Fonctionnement à connaître

* **Temps réel** : une saisie validée sur un appareil apparaît sur les autres en une à deux secondes (flux Server-Sent Events).
* **Hors ligne** : sans réseau, l'appareil travaille sur sa copie locale ; les saisies sont conservées (même si l'application
  est fermée) et partent automatiquement au retour du réseau. Le bouton nuage en haut de l'écran indique l'état et le nombre
  de saisies en attente ; un appui ouvre le détail.
* **Le serveur fait foi** : chaque saisie est réexécutée par le serveur avec les mêmes règles. Si l'état a changé entre-temps
  (ex. deux sites hors ligne sortent la même dernière pièce), la seconde saisie est **refusée et signalée** à son auteur avec
  le motif, et le stock affiché est corrigé. Rien n'est fusionné en silence.
* **Connexion hors ligne** : possible pour un compte qui s'est déjà connecté en ligne sur cet appareil au cours des 30 derniers
  jours. La toute première connexion d'un appareil exige le réseau.
* **Sessions** : 12 h sans activité (réglable, `SESSION_HOURS`). Un compte supprimé, ou dont le PIN est changé par un
  administrateur, est déconnecté de tous ses appareils. Les sessions expirées (appareils perdus) sont purgées chaque heure.
* **Archivage** : les commandes soldées et les transferts terminés depuis plus de 400 jours (`ARCHIVE_DAYS`, 0 = jamais)
  quittent la base envoyée aux appareils et rejoignent `archive-orders.jsonl` / `archive-transfers.jsonl` sur le serveur.
  Les rapports, seuils et délais mesurés n'utilisent que des données plus récentes.
* **Poids** : l'application est servie compressée (Brotli ou gzip) par le serveur lui-même ; rien à configurer dans Caddy.
* **Changer le code d'accès** (fuite, départ) : modifier `ORG_CODE` puis `docker compose up -d`. Chaque appareil devra
  ressaisir le nouveau code à sa prochaine connexion.

## 5. Impression des étiquettes

Le profil d'imprimante est réglé **par appareil** (*Menu → Imprimante*) :

* **Imprimante de bureau** : planches A4 (3×8, 3×7, 2×7) avec saut des étiquettes déjà utilisées, ou A4 simple.
* **Imprimante thermique (Intermec / Honeywell…)**, rouleaux 50×25, 60×40, 100×50 mm :
  * *impression système* : l'imprimante est installée sur le téléphone, la tablette ou le PC (pilote ou application du
    fabricant, AirPrint, Mopria) — c'est le chemin recommandé ;
  * *fichier ZPL* (203, 300 ou 406 dpi) : à transmettre à l'imprimante par l'outil du fabricant, un partage réseau ou l'USB.
    Les Intermec/Honeywell récentes acceptent le ZPL via leur **émulation ZPL** (ZSim selon les modèles), à activer dans
    l'imprimante. **À valider sur vos modèles** : l'impression thermique n'a pas pu être testée sur du matériel réel.

## 6. Sauvegardes

Les données sont dans le volume Docker `mode-data` : `snapshot.json` (instantané), `events.jsonl` (journal des opérations
depuis l'instantané, écrit et synchronisé sur disque avant chaque réponse), `sessions.json`, `backups/` (sauvegardes
quotidiennes), `archive-history.jsonl` (historique au-delà de 200 000 mouvements), `archive-orders.jsonl` et
`archive-transfers.jsonl` (documents archivés).

* **Sauvegardes automatiques** : chaque jour (et au démarrage s'il manque celle du jour), une sauvegarde complète est
  écrite dans `backups/mode-stock-AAAA-MM-JJ.json` ; les 14 derniers jours sont conservés (`BACKUP_KEEP`, 0 = désactivées).
  Elles sont listées et téléchargeables dans Administration → Données : pour revenir à un jour donné (erreur de saisie en
  masse, mauvaise restauration…), téléchargez-le puis *Restaurer une sauvegarde sur le serveur*. Elles restent sur le
  serveur : elles ne remplacent pas une copie **hors** du serveur.
* **Sauvegarde applicative hors du serveur** (recommandée, hebdomadaire au moins) : Administration → Données →
  *Télécharger la sauvegarde du serveur*. Le fichier contient les empreintes de PIN : à conserver comme un secret.
* **Sauvegarde du volume** (ex. tâche cron nocturne) :
  ```bash
  docker run --rm -v spare-part_mode-data:/data -v "$PWD/backups":/b alpine \
    tar czf "/b/mode-$(date +%F).tgz" -C /data .
  ```
  (Le nom exact du volume est donné par `docker volume ls`.) Une copie prise pendant le fonctionnement est cohérente au
  redémarrage : une dernière ligne de journal incomplète est ignorée.
* **Restaurer** : Administration → Données → *Restaurer une sauvegarde sur le serveur*. Tous les appareils rechargent les
  données ; les autres sessions sont fermées.

## 7. Mises à jour

```bash
git pull
docker compose up -d --build
```

Arrêt propre (journal et instantané écrits), redémarrage en quelques secondes ; les appareils se reconnectent seuls et
envoient ce qu'ils ont saisi entre-temps. Ils proposent ensuite « Mettre à jour » (nouvelle version de l'application) sans
jamais l'imposer en pleine saisie.

## 8. Sécurité

* HTTPS obligatoire (Caddy), en-têtes stricts (CSP, `frame-ancestors 'none'`, HSTS, `nosniff`, pas de référent).
* Le code d'accès protège l'annuaire (liste des comptes) et la connexion ; sans lui, rien n'est exposé.
* PIN vérifiés par le serveur (PBKDF2), verrouillage progressif par compte (30 s → 15 min) et limitation par adresse IP.
* Session : jeton aléatoire de 256 bits dans un cookie `HttpOnly`, `SameSite=Strict`, `Secure` ; le serveur n'en garde que l'empreinte.
* Écritures : JSON et même origine exigés (protection CSRF) ; chaque opération est contrôlée par les règles métier avec
  l'identité de la session (jamais celle annoncée par l'appareil).
* Les appareils ne reçoivent **aucune empreinte de PIN** des autres comptes ; seule la leur est gardée, pour la connexion hors ligne.
* Clé Anthropic uniquement sur le serveur ; quota quotidien par compte (`AI_DAILY_LIMIT`).

**Limites assumées** : un serveur unique (pas de haute disponibilité : s'il tombe, les sites continuent hors ligne et se
resynchronisent ensuite) ; un PIN reste court — le code d'accès, le verrouillage et les sessions compensent ; l'empreinte de
PIN conservée sur un appareil pour la connexion hors ligne reste attaquable par quelqu'un qui dispose de l'appareil déverrouillé.

## 9. Dépannage

| Symptôme | Piste |
|---|---|
| « Serveur injoignable » au premier lancement | DNS, ports 80/443, `docker compose ps`, `docker compose logs caddy`. |
| Caméra refusée | L'adresse doit être en HTTPS ; autoriser la caméra pour le site dans les réglages du navigateur. |
| Bouton nuage rouge « Reconnexion nécessaire » | Session expirée ou révoquée : se reconnecter (les saisies en attente partent ensuite). |
| Saisie « refusée par le serveur » | L'état avait changé (autre site, autre appareil) : lire le motif dans le détail, vérifier, ressaisir si besoin. |
| Analyse photo indisponible | `ANTHROPIC_API_KEY` absente ou refusée (journaux du serveur), ou quota du jour atteint. |
| Démarrage refusé « events.jsonl : ligne N illisible » | Corruption du journal au milieu (disque) : restaurer la dernière sauvegarde du volume. |

Vérification rapide : `curl https://<DOMAIN>/api/config` → `{"server":true,…}`.
