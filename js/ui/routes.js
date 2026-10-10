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
}
