// ============================================================
// Agent Barrel Exports
// Thin wrappers that compose services into pipeline operations
// ============================================================

export {
  initStoreManager,
  addProduct,
  updateProductDetails,
  syncInventoryFromCatalog,
  organizeCollection,
  bulkUpdatePricing,
  getStoreStatus,
} from './store-manager.js';

export {
  initListingPublisher,
  publishProduct,
  publishBatch,
  retryFailedListings,
  verifyPublication,
} from './listing-publisher.js';

export {
  initFulfillmentMonitor,
  checkOrder,
  monitorAllOrders,
  checkSlaCompliance,
  sendAlert,
  runMonitoringCycle,
  loadFulfillmentState,
  saveFulfillmentState,
} from './fulfillment-monitor.js';

export {
  initOrchestrator,
  runNewProductPipeline,
  runBatchProductPipeline,
  runFulfillmentCheck,
  runStoreHealthCheck,
  getSessionState,
  loadSessionState,
  saveSessionState,
} from './orchestrator.js';
