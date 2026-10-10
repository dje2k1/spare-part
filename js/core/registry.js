// Registre des opérations : nom stable ↔ fonction. Le NOM est ce qui circule entre un appareil et le serveur
// (file d'attente hors ligne, journal du serveur) : ne jamais renommer une entrée existante.
// Toute opération a la forme `(db, ctx, params)` où `params` est un objet sérialisable en JSON.
import * as stock from './ops.js';
import * as orders from './ops-orders.js';

/** Import CSV : `{ rows, dryRun?, applyStock? }`. */
export const importCatalogueOp = (db, ctx, p) => stock.importCatalogue(db, ctx, p?.rows, { dryRun: p?.dryRun === true, applyStock: p?.applyStock === true });
/** Pièces suggérées par l'analyse photo : `{ parts }`. */
export const importSuggestedPartsOp = (db, ctx, p) => stock.importSuggestedParts(db, ctx, p?.parts);

export const OPS = Object.freeze({
  recordAuth: stock.recordAuth,
  moveStock: stock.moveStock,
  undoMovement: stock.undoMovement,
  adjustStock: stock.adjustStock,
  commitInventory: stock.commitInventory,
  createTransfer: stock.createTransfer,
  receiveTransfer: stock.receiveTransfer,
  cancelTransfer: stock.cancelTransfer,
  refuseTransfer: stock.refuseTransfer,
  upsertArticle: stock.upsertArticle,
  deleteArticle: stock.deleteArticle,
  setArticleLocation: stock.setArticleLocation,
  removeArticleLocation: stock.removeArticleLocation,
  saveLocation: stock.saveLocation,
  deleteLocation: stock.deleteLocation,
  saveDepot: stock.saveDepot,
  deleteDepot: stock.deleteDepot,
  saveUser: stock.saveUser,
  deleteUser: stock.deleteUser,
  changeOwnPin: stock.changeOwnPin,
  updateSettings: stock.updateSettings,
  importCatalogue: importCatalogueOp,
  importSuggestedParts: importSuggestedPartsOp,
  saveSupplier: orders.saveSupplier,
  deleteSupplier: orders.deleteSupplier,
  setLevels: orders.setLevels,
  setDraftLines: orders.setDraftLines,
  submitOrder: orders.submitOrder,
  discardDraft: orders.discardDraft,
  cancelOrder: orders.cancelOrder,
  claimOrder: orders.claimOrder,
  releaseOrder: orders.releaseOrder,
  shipOrder: orders.shipOrder,
  receiveOrder: orders.receiveOrder,
  savePurchaseDraft: orders.savePurchaseDraft,
  deletePurchaseDraft: orders.deletePurchaseDraft,
  sendPurchase: orders.sendPurchase,
  receivePurchase: orders.receivePurchase,
  closePurchase: orders.closePurchase,
});

const NAMES = new Map(Object.entries(OPS).map(([name, fn]) => [fn, name]));

/** Nom d'une opération à partir de sa fonction (erreur de programmation si elle n'est pas enregistrée). */
export function opName(fn) {
  const name = NAMES.get(fn);
  if (!name) throw new Error(`Opération non enregistrée dans registry.js : ${fn?.name || fn}`);
  return name;
}

export const isOpName = (name) => typeof name === 'string' && Object.hasOwn(OPS, name);
