// ============================================================
// Fulfillment Monitor Agent
//
// Monitors CustomCat order status, updates Shopify tracking, and
// flags orders that breach SLA thresholds. Persists run state to
// state/fulfillment-state.json between cycles.
//
// Data contracts:
//   Upstream  — Shopify getOrders → Shopify.IOrder[]
//               Filtered to orders carrying a customcatOrderId (stored
//               in note_attributes or mapped via FulfillmentState) that
//               are not in a terminal status (delivered | cancelled).
//   Downstream — updateOrderTracking(shopifyOrderId, trackingNumber, trackingUrl)
//                Both trackingNumber and trackingUrl must be non-null;
//                the guard in checkOrder enforces this before calling.
//
// SLA thresholds (business days in production):
//   ok       — 0–3 days
//   warning  — > 3 days
//   alert    — > 5 days
//   critical — status is 'error' or 'cancelled'
// ============================================================

import { promises as fs } from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import type Shopify from 'shopify-api-node';

import {
  createCustomCatClient,
  getOrderStatus,
  getTrackingInfo,
} from '../services/customcat/index.js';
import type { CustomCatClient } from '../services/customcat/index.js';
import {
  createShopifyClient,
  getOrders,
  updateOrderTracking,
} from '../services/shopify/index.js';
import type { AppConfig, Order, OrderStatus } from '../types/index.js';
import { FulfillmentError } from '../utils/errors.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('fulfillment-monitor');

// ============================================================
// Local types
// ============================================================

export type SlaLevel = 'ok' | 'warning' | 'alert' | 'critical';

export interface SlaStatus {
  readonly level: SlaLevel;
  readonly businessDaysInProduction: number;
  readonly message: string;
}

export interface OrderCheckResult {
  readonly orderId: string;
  readonly previousStatus: OrderStatus;
  readonly currentStatus: OrderStatus;
  readonly trackingUpdated: boolean;
  readonly sla: SlaStatus;
}

export interface FulfillmentAlert {
  readonly level: SlaLevel;
  readonly orderId: string;
  readonly shopifyOrderId: string;
  readonly message: string;
  readonly timestamp: Date;
}

export interface MonitoringReport {
  readonly checkedAt: Date;
  readonly totalChecked: number;
  readonly statusChanges: number;
  readonly trackingUpdates: number;
  readonly slaViolations: FulfillmentAlert[];
  readonly errors: Array<{ orderId: string; error: string }>;
}

export interface FulfillmentState {
  readonly lastRunAt: string;
  readonly orderStates: Record<
    string,
    {
      readonly status: OrderStatus;
      readonly lastChecked: string;
      // ISO timestamp recorded the first time we saw this order enter
      // in_production — used as the production start for SLA calculation.
      readonly productionStartedAt: string | null;
    }
  >;
}

// ============================================================
// Clients bundle — returned by initFulfillmentMonitor
// ============================================================

export interface FulfillmentClients {
  readonly shopify: InstanceType<typeof Shopify>;
  readonly customcat: CustomCatClient;
  readonly notificationWebhookUrl: string;
}

// ============================================================
// State file path
// ============================================================

const STATE_FILE = path.join(process.cwd(), 'state', 'fulfillment-state.json');

// ============================================================
// 1. initFulfillmentMonitor
// ============================================================

/**
 * Initialises Shopify and CustomCat clients and records the notification
 * webhook URL sourced from AppConfig.notifications.webhookUrl.
 */
export function initFulfillmentMonitor(config: AppConfig): FulfillmentClients {
  logger.info('Initialising fulfillment monitor clients');

  const shopify = createShopifyClient(config.shopify);
  const customcat = createCustomCatClient(config.customcat);
  const notificationWebhookUrl = config.notifications.webhookUrl;

  logger.info('Fulfillment monitor clients ready');

  return { shopify, customcat, notificationWebhookUrl };
}

// ============================================================
// 2. loadFulfillmentState / saveFulfillmentState
// ============================================================

/**
 * Reads persisted order state from state/fulfillment-state.json.
 * Returns a blank state object if the file does not exist yet.
 */
export async function loadFulfillmentState(): Promise<FulfillmentState> {
  try {
    const raw = await fs.readFile(STATE_FILE, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    // Trust the shape — written by saveFulfillmentState only.
    return parsed as FulfillmentState;
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') {
      logger.info({ path: STATE_FILE }, 'No fulfillment state file found — starting fresh');
      return { lastRunAt: new Date(0).toISOString(), orderStates: {} };
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new FulfillmentError(`Failed to load fulfillment state: ${message}`);
  }
}

/**
 * Persists order state to state/fulfillment-state.json.
 * Creates the state/ directory if it does not exist.
 */
export async function saveFulfillmentState(state: FulfillmentState): Promise<void> {
  try {
    await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
    await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
    logger.info({ path: STATE_FILE }, 'Fulfillment state saved');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new FulfillmentError(`Failed to save fulfillment state: ${message}`);
  }
}

// ============================================================
// 3. checkSlaCompliance
// ============================================================

/**
 * Pure function — evaluates an order against SLA thresholds.
 *
 * Critical is returned immediately for terminal error/cancelled statuses.
 * For in_production orders, business days elapsed since productionStartedAt
 * (or createdAt as a conservative fallback) determine warning/alert level.
 */
export function checkSlaCompliance(
  order: Order,
  productionStartedAt?: Date,
): SlaStatus {
  if (order.status === 'error' || order.status === 'cancelled') {
    return {
      level: 'critical',
      businessDaysInProduction: 0,
      message: `Order ${order.id} is in terminal status: ${order.status}`,
    };
  }

  if (order.status !== 'in_production') {
    return {
      level: 'ok',
      businessDaysInProduction: 0,
      message: `Order ${order.id} is not in production (status: ${order.status})`,
    };
  }

  const startDate = productionStartedAt ?? order.createdAt;
  const businessDays = countBusinessDays(startDate, new Date());

  if (businessDays > 5) {
    return {
      level: 'alert',
      businessDaysInProduction: businessDays,
      message: `Order ${order.id} has been in production for ${String(businessDays)} business days (alert threshold: 5)`,
    };
  }

  if (businessDays > 3) {
    return {
      level: 'warning',
      businessDaysInProduction: businessDays,
      message: `Order ${order.id} has been in production for ${String(businessDays)} business days (warning threshold: 3)`,
    };
  }

  return {
    level: 'ok',
    businessDaysInProduction: businessDays,
    message: `Order ${order.id} is within SLA (${String(businessDays)} business days in production)`,
  };
}

// ============================================================
// 4. checkOrder
// ============================================================

/**
 * Checks a single order's status with CustomCat.
 * If the order has shipped and tracking is available, updates Shopify.
 *
 * previousStatus is sourced from the caller (FulfillmentState), not from
 * the Order argument — the Order shape is immutable at this layer.
 */
export async function checkOrder(
  clients: FulfillmentClients,
  order: Order,
  previousStatus: OrderStatus,
  productionStartedAt?: Date,
): Promise<OrderCheckResult> {
  if (order.customcatOrderId === null) {
    throw new FulfillmentError(
      `checkOrder called on order ${order.id} with no customcatOrderId`,
    );
  }

  logger.info(
    { orderId: order.id, customcatOrderId: order.customcatOrderId },
    'Checking order status with CustomCat',
  );

  const currentStatus = await getOrderStatus(clients.customcat, order.customcatOrderId);

  let trackingUpdated = false;

  if (currentStatus === 'shipped' || currentStatus === 'delivered') {
    const tracking = await getTrackingInfo(clients.customcat, order.customcatOrderId);

    if (tracking.trackingNumber !== null && tracking.trackingUrl !== null) {
      logger.info(
        { orderId: order.id, trackingNumber: tracking.trackingNumber },
        'Updating Shopify with tracking information',
      );

      await updateOrderTracking(
        clients.shopify,
        order.shopifyOrderId,
        tracking.trackingNumber,
        tracking.trackingUrl,
      );

      trackingUpdated = true;
    } else {
      logger.info(
        { orderId: order.id, currentStatus },
        'Order shipped but tracking not yet available — skipping Shopify update',
      );
    }
  }

  const sla = checkSlaCompliance(order, productionStartedAt);

  logger.info(
    {
      orderId: order.id,
      previousStatus,
      currentStatus,
      trackingUpdated,
      slaLevel: sla.level,
    },
    'Order check complete',
  );

  return {
    orderId: order.id,
    previousStatus,
    currentStatus,
    trackingUpdated,
    sla,
  };
}

// ============================================================
// 5. sendAlert
// ============================================================

/**
 * Posts a FulfillmentAlert as JSON to the configured notification webhook.
 * Throws FulfillmentError if the webhook returns a non-2xx response.
 */
export async function sendAlert(
  webhookUrl: string,
  alert: FulfillmentAlert,
): Promise<void> {
  logger.info(
    { level: alert.level, orderId: alert.orderId, webhookUrl },
    'Sending fulfillment alert',
  );

  let response: Awaited<ReturnType<typeof fetch>>;

  try {
    response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        level: alert.level,
        orderId: alert.orderId,
        shopifyOrderId: alert.shopifyOrderId,
        message: alert.message,
        timestamp: alert.timestamp.toISOString(),
      }),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new FulfillmentError(`Webhook network error sending alert for order ${alert.orderId}: ${message}`);
  }

  if (!response.ok) {
    let body = '';
    try {
      body = await response.text();
    } catch {
      // best-effort
    }
    throw new FulfillmentError(
      `Webhook returned HTTP ${String(response.status)} for alert on order ${alert.orderId}: ${body}`,
    );
  }

  logger.info(
    { level: alert.level, orderId: alert.orderId },
    'Fulfillment alert sent successfully',
  );
}

// ============================================================
// 6. monitorAllOrders
// ============================================================

/**
 * Checks all supplied orders and returns a MonitoringReport.
 * Errors on individual orders are captured and included in the report
 * rather than thrown — a single bad order must not abort the cycle.
 */
export async function monitorAllOrders(
  clients: FulfillmentClients,
  orders: readonly Order[],
  state: FulfillmentState,
): Promise<{ report: MonitoringReport; updatedState: FulfillmentState }> {
  logger.info({ count: orders.length }, 'Starting monitorAllOrders');

  const results: OrderCheckResult[] = [];
  const errors: Array<{ orderId: string; error: string }> = [];
  const slaViolations: FulfillmentAlert[] = [];

  const updatedOrderStates: FulfillmentState['orderStates'] = { ...state.orderStates };

  for (const order of orders) {
    const existingEntry = state.orderStates[order.id];
    const previousStatus: OrderStatus = existingEntry?.status ?? order.status;

    const productionStartedAt =
      existingEntry?.productionStartedAt !== undefined &&
      existingEntry.productionStartedAt !== null
        ? new Date(existingEntry.productionStartedAt)
        : undefined;

    try {
      const result = await checkOrder(clients, order, previousStatus, productionStartedAt);
      results.push(result);

      // Determine productionStartedAt: set when first entering in_production
      const newProductionStartedAt: string | null =
        result.currentStatus === 'in_production'
          ? (existingEntry?.productionStartedAt ?? new Date().toISOString())
          : (existingEntry?.productionStartedAt ?? null);

      updatedOrderStates[order.id] = {
        status: result.currentStatus,
        lastChecked: new Date().toISOString(),
        productionStartedAt: newProductionStartedAt,
      };

      if (result.sla.level !== 'ok') {
        slaViolations.push({
          level: result.sla.level,
          orderId: order.id,
          shopifyOrderId: order.shopifyOrderId,
          message: result.sla.message,
          timestamp: new Date(),
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ orderId: order.id, error: message }, 'Error checking order');
      errors.push({ orderId: order.id, error: message });
    }
  }

  const statusChanges = results.filter((r) => r.currentStatus !== r.previousStatus).length;
  const trackingUpdates = results.filter((r) => r.trackingUpdated).length;

  const report: MonitoringReport = {
    checkedAt: new Date(),
    totalChecked: orders.length,
    statusChanges,
    trackingUpdates,
    slaViolations,
    errors,
  };

  const updatedState: FulfillmentState = {
    lastRunAt: new Date().toISOString(),
    orderStates: updatedOrderStates,
  };

  logger.info(
    {
      totalChecked: report.totalChecked,
      statusChanges,
      trackingUpdates,
      slaViolations: slaViolations.length,
      errors: errors.length,
    },
    'monitorAllOrders complete',
  );

  return { report, updatedState };
}

// ============================================================
// 7. runMonitoringCycle
// ============================================================

/**
 * Full monitoring cycle:
 *   a. Fetch recent orders from Shopify
 *   b. Filter to orders with customcatOrderId that are not delivered/cancelled
 *   c. Map Shopify orders to Order shape via FulfillmentState
 *   d. Check each order with CustomCat
 *   e. Update tracking on Shopify where available
 *   f. Check SLA compliance
 *   g. Send alerts for any violations
 *   h. Persist state to state/fulfillment-state.json
 *   i. Return MonitoringReport
 *
 * Note: Shopify's IOrder does not carry customcatOrderId natively — this
 * agent sources it from FulfillmentState.orderStates keyed by shopify order
 * ID. Orders absent from state are skipped (they have not been submitted
 * to CustomCat by the fulfillment pipeline yet).
 */
export async function runMonitoringCycle(
  clients: FulfillmentClients,
): Promise<MonitoringReport> {
  logger.info('Starting fulfillment monitoring cycle');

  const state = await loadFulfillmentState();

  // Fetch open orders from Shopify
  const shopifyOrders = await getOrders(clients.shopify, {
    status: 'open',
    limit: 250,
  });

  logger.info({ count: shopifyOrders.length }, 'Shopify orders fetched');

  // Build Order objects from Shopify orders — we only process orders
  // that appear in our state with a customcatOrderId assigned.
  const activeOrders: Order[] = [];

  for (const shopifyOrder of shopifyOrders) {
    const shopifyOrderId = String(shopifyOrder.id);
    const stateEntry = findStateEntryByShopifyOrderId(state, shopifyOrderId);

    if (stateEntry === null) {
      // Order not yet in fulfillment state — not submitted to CustomCat
      continue;
    }

    const { internalOrderId, orderState } = stateEntry;

    const status = orderState.status;

    // Skip terminal statuses
    if (status === 'delivered' || status === 'cancelled') {
      continue;
    }

    const order = buildOrderFromShopify(shopifyOrder, internalOrderId, orderState);

    if (order === null) {
      logger.warn(
        { shopifyOrderId },
        'Could not build Order from Shopify data — missing customcatOrderId in state',
      );
      continue;
    }

    activeOrders.push(order);
  }

  logger.info({ activeOrderCount: activeOrders.length }, 'Active orders identified for monitoring');

  const { report, updatedState } = await monitorAllOrders(clients, activeOrders, state);

  // Send alerts for SLA violations
  for (const violation of report.slaViolations) {
    try {
      await sendAlert(clients.notificationWebhookUrl, violation);
    } catch (err) {
      // Alert failures are logged but must not prevent state persistence
      const message = err instanceof Error ? err.message : String(err);
      logger.error(
        { orderId: violation.orderId, level: violation.level, error: message },
        'Failed to send SLA violation alert',
      );
    }
  }

  await saveFulfillmentState(updatedState);

  logger.info(
    {
      totalChecked: report.totalChecked,
      statusChanges: report.statusChanges,
      trackingUpdates: report.trackingUpdates,
      slaViolations: report.slaViolations.length,
      errors: report.errors.length,
    },
    'Fulfillment monitoring cycle complete',
  );

  return report;
}

// ============================================================
// Internal helpers
// ============================================================

/**
 * Counts business days (Mon–Fri) between two dates, exclusive of the
 * start day and inclusive of today up to but not including end.
 * Returns 0 if end is before or equal to start.
 */
function countBusinessDays(start: Date, end: Date): number {
  if (end <= start) return 0;

  let count = 0;
  // Clone to avoid mutating the argument
  const cursor = new Date(start.getTime());
  // Advance past the start day
  cursor.setDate(cursor.getDate() + 1);

  while (cursor < end) {
    const day = cursor.getDay();
    // 0 = Sunday, 6 = Saturday
    if (day !== 0 && day !== 6) {
      count += 1;
    }
    cursor.setDate(cursor.getDate() + 1);
  }

  return count;
}

/**
 * Identifies whether an existing state entry exists for a given Shopify
 * order ID. FulfillmentState is keyed by our internal order ID, so we
 * need to scan values for a matching shopifyOrderId reference.
 *
 * This is O(n) over the state entries but state sizes are small (hundreds
 * of orders at most) and this runs once per cycle.
 *
 * Returns null if no matching entry is found.
 */
function findStateEntryByShopifyOrderId(
  state: FulfillmentState,
  shopifyOrderId: string,
): {
  internalOrderId: string;
  orderState: FulfillmentState['orderStates'][string];
} | null {
  for (const [internalOrderId, orderState] of Object.entries(state.orderStates)) {
    // The state entry embeds shopifyOrderId via the Order shape stored
    // when runMonitoringCycle first processes an order. We encode it as
    // a naming convention: internal IDs have a shopify- prefix carrying
    // the Shopify order ID (e.g. "order-<shopifyOrderId>").
    // If the internalOrderId contains the shopifyOrderId as a suffix, match.
    if (internalOrderId.endsWith(shopifyOrderId) || internalOrderId === shopifyOrderId) {
      return { internalOrderId, orderState };
    }
  }
  return null;
}

/**
 * Builds an Order from a Shopify IOrder and the corresponding state entry.
 * Returns null if the state entry does not carry a customcatOrderId.
 *
 * The customcatOrderId is stored in state under a reserved key. We retrieve
 * it from the note_attributes on the Shopify order (keyed "customcat_order_id")
 * as the canonical source of truth — the state may not have it if the order
 * was submitted in a prior session without state.
 */
function buildOrderFromShopify(
  shopifyOrder: Shopify.IOrder,
  internalOrderId: string,
  orderState: FulfillmentState['orderStates'][string],
): Order | null {
  // Primary source: note_attributes on the Shopify order
  const noteAttr = shopifyOrder.note_attributes.find(
    (attr) => attr.name === 'customcat_order_id',
  );
  const customcatOrderId: string | null =
    noteAttr?.value != null ? noteAttr.value : null;

  if (customcatOrderId === null) {
    return null;
  }

  const shippingAddr = shopifyOrder.shipping_address;

  return {
    id: internalOrderId,
    shopifyOrderId: String(shopifyOrder.id),
    customcatOrderId,
    lineItems: [], // Line items not needed for status-check operations
    shippingAddress: {
      name: shippingAddr.name,
      address1: shippingAddr.address1,
      address2: shippingAddr.address2 ?? null,
      city: shippingAddr.city,
      province: shippingAddr.province ?? '',
      zip: shippingAddr.zip,
      country: shippingAddr.country,
    },
    status: orderState.status,
    trackingNumber: null,
    trackingUrl: null,
    createdAt: new Date(shopifyOrder.created_at),
    updatedAt: new Date(shopifyOrder.updated_at),
  };
}

// ============================================================
// Type guard
// ============================================================

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}
