// Registre des écrans : nom de route → définition. Chaque vue exporte sa définition et son init().
import { homeRoute, initHome } from './views/home.js';
import { scanRoute, initScan } from './views/scan.js';
import { initArticleSheet } from './views/article-sheet.js';
import { articlesRoute, reorderRoute, initArticles } from './views/articles.js';
import { planRoute, initPlan } from './views/plan.js';
import { transfersRoute, initTransfers } from './views/transfers.js';
import { journalRoute, initJournal } from './views/journal.js';
import { photoRoute, initPhoto } from './views/photo.js';
import { inventoryRoute, initInventory } from './views/inventory.js';
import { dashboardRoute, initDashboard } from './views/dashboard.js';
import { adminRoute, initAdmin } from './views/admin.js';
import { ordersRoute, initOrders } from './views/orders.js';
import { cartRoute, initCart } from './views/order-cart.js';
import { receiveRoute, initReceive } from './views/receive.js';
import { pickRoute, initPick } from './views/pick.js';
import { purchasesRoute, purchaseRoute, suppliersRoute, initPurchases } from './views/purchases.js';
import { levelsRoute, initLevels } from './views/levels.js';
import { labelsRoute, initLabels } from './views/labels.js';
import { reportsRoute, initReports } from './views/reports.js';

export const routes = {
  home: homeRoute,
  scan: scanRoute,
  articles: articlesRoute,
  reorder: reorderRoute,
  plan: planRoute,
  transfers: transfersRoute,
  journal: journalRoute,
  photo: photoRoute,
  inventory: inventoryRoute,
  dashboard: dashboardRoute,
  admin: adminRoute,
  orders: ordersRoute,
  order: cartRoute,
  receive: receiveRoute,
  preceive: receiveRoute,
  pick: pickRoute,
  purchases: purchasesRoute,
  purchase: purchaseRoute,
  suppliers: suppliersRoute,
  levels: levelsRoute,
  labels: labelsRoute,
  reports: reportsRoute,
};

export function initViews() {
  initHome();
  initScan();
  initArticleSheet();
  initArticles();
  initPlan();
  initTransfers();
  initJournal();
  initPhoto();
  initInventory();
  initDashboard();
  initAdmin();
  initOrders();
  initCart();
  initReceive();
  initPick();
  initPurchases();
  initLevels();
  initLabels();
  initReports();
}
