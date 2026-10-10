// Constantes de l'application : version, clés de stockage, limites, rôles et permissions.

export const APP_VERSION = '3.0.0';
export const APP_LABEL = 'Version 3'; // pastille affichée sur l'accueil
export const DB_VERSION = 6;

export const KEYS = {
  db: 'mode_stock_v5',
  legacyDb: 'dior_v4', // ancien format (PIN en clair) : migré puis supprimé
  legacyOld: ['dior_v1', 'dior_v2', 'dior_v3', 'stockpieces_v2'],
  prefs: 'mode_prefs',
  lock: 'mode_auth_lock',
  apiKey: 'mode_anthropic_api_key', // même clé que index2.html : une clé déjà saisie reste valable
  legacyApiKeys: ['mode_anthropic_key'],
  session: 'mode_inventory_draft',
  // Synchronisation (mode serveur)
  syncQueue: 'mode_sync_queue', // opérations en attente d'envoi (survit à la fermeture de l'application)
  syncState: 'mode_sync_state', // version confirmée + session serveur
  knownUsers: 'mode_known_users', // empreintes des comptes déjà connectés sur CET appareil (déverrouillage hors ligne)
  orgCode: 'mode_org_code',
  briefing: 'mode_briefing_seen',
};

export const LIMITS = {
  maxQty: 1_000_000, // quantité d'une opération
  maxStock: 10_000_000, // stock d'un article dans un dépôt
  history: 3000,
  audit: 1500,
  name: 120,
  short: 60,
  ref: 40,
  rows: 5000, // lignes d'un import CSV
  backupBytes: 25 * 1024 * 1024,
  undoWindowMs: 15 * 60 * 1000,
};

export const ROLES = {
  admin: { label: 'Administrateur', hint: 'Accès complet, tous les dépôts' },
  manager: { label: 'Responsable dépôt', hint: 'Stock, catalogue, inventaire, exports' },
  operator: { label: 'Opérateur', hint: 'Entrées, sorties, transferts' },
};

// order.fulfil (préparer/expédier) n'est utilisable que par le personnel de l'entrepôt central : contrôlé dans ops-orders.js.
const OPERATOR = ['move', 'transfer.create', 'transfer.receive', 'article.create', 'order.request', 'order.receive', 'order.fulfil', 'labels'];
const MANAGER = [...OPERATOR, 'article.edit', 'stock.adjust', 'inventory', 'import', 'export', 'audit.view', 'location.edit', 'transfer.cancel',
  'order.manage', 'purchase.manage', 'supplier.manage', 'levels.manage', 'reports'];
const ADMIN = [...MANAGER, 'user.manage', 'depot.manage', 'data.manage', 'depot.any'];
export const PERMISSIONS = {
  operator: new Set(OPERATOR),
  manager: new Set(MANAGER),
  admin: new Set(ADMIN),
};

/** Types de mouvements : libellé, signe d'affichage, famille de couleur. */
export const MOVES = {
  in: { label: 'Entrée', sign: '+', tone: 'in' },
  out: { label: 'Sortie', sign: '−', tone: 'out' },
  transfer: { label: 'Transfert sortant', sign: '−', tone: 'transfer' },
  transfer_in: { label: 'Transfert entrant', sign: '+', tone: 'in' },
  transfer_cancel: { label: 'Transfert annulé', sign: '+', tone: 'transfer' },
  inv: { label: 'Inventaire', sign: '→', tone: 'inv' },
};

export const REASONS = {
  in: ['Réception fournisseur', 'Retour atelier', 'Production', 'Autre'],
  out: ['Production', 'Casse / rebut', 'Retour fournisseur', 'Échantillon', 'Autre'],
};

export const AUDIT_TYPES = {
  in: 'Entrées', out: 'Sorties', inv: 'Inventaires', transfer: 'Transferts', order: 'Commandes', login: 'Connexions', admin: 'Administration',
};

export const TRANSFER_STATUS = {
  pending: 'En transit', done: 'Reçu', cancelled: 'Annulé', refused: 'Refusé',
};

export const DEPOT_KINDS = {
  atelier: { label: 'Atelier', hint: 'Consomme les pièces, commande à l\'entrepôt central' },
  central: { label: 'Entrepôt central', hint: 'Approvisionne les ateliers, commande aux fournisseurs' },
};

/** Commandes : internes (atelier → entrepôt central) et fournisseurs (entrepôt central → fournisseur). */
export const ORDER_STATUS = {
  draft: 'Brouillon', submitted: 'Envoyée', picking: 'En préparation', shipped: 'Expédiée',
  received: 'Reçue', cancelled: 'Annulée', sent: 'Envoyée au fournisseur', partial: 'Reçue en partie', closed: 'Soldée',
};
export const ORDER_LIMITS = { lines: 500 };

export const DEFAULT_SETTINGS = {
  sessionMinutes: 15,
  leadDaysInternal: 2, // délai entrepôt → atelier (remplacé par le délai mesuré dès qu'il existe)
  leadDaysSupplier: 14, // délai fournisseur par défaut (fiche fournisseur prioritaire)
  coverDaysAtelier: 14, // stock maximum d'un atelier = seuil + N jours de consommation
  coverDaysCentral: 30,
  serviceLevel: 95, // % : probabilité de ne pas être en rupture pendant le délai de réapprovisionnement
  briefing: true, // « Votre journée » à la première ouverture du jour
};
