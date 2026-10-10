// Constantes de l'application : version, clés de stockage, limites, rôles et permissions.

export const APP_VERSION = '2.0.0';
export const APP_LABEL = 'Version 2'; // pastille affichée sur l'accueil
export const DB_VERSION = 5;

export const KEYS = {
  db: 'mode_stock_v5',
  legacyDb: 'dior_v4', // ancien format (PIN en clair) : migré puis supprimé
  legacyOld: ['dior_v1', 'dior_v2', 'dior_v3', 'stockpieces_v2'],
  prefs: 'mode_prefs',
  lock: 'mode_auth_lock',
  apiKey: 'mode_anthropic_api_key', // même clé que index2.html : une clé déjà saisie reste valable
  legacyApiKeys: ['mode_anthropic_key'],
  session: 'mode_inventory_draft',
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

const OPERATOR = ['move', 'transfer.create', 'transfer.receive', 'article.create'];
const MANAGER = [...OPERATOR, 'article.edit', 'stock.adjust', 'inventory', 'import', 'export', 'audit.view', 'location.edit', 'transfer.cancel', 'labels'];
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
  in: 'Entrées', out: 'Sorties', inv: 'Inventaires', transfer: 'Transferts', login: 'Connexions', admin: 'Administration',
};

export const TRANSFER_STATUS = {
  pending: 'En transit', done: 'Reçu', cancelled: 'Annulé', refused: 'Refusé',
};

export const DEFAULT_SETTINGS = { sessionMinutes: 15 };
