// ============================================================
// CustomCat Fulfillment Service
// Handles order submission, status tracking, and product catalog queries
// against the CustomCat REST API.
//
// Data contract note: OrderLineItem carries a designId but not resolved
// print file URLs. Callers must supply print file URLs per line item via
// OrderLineItemWithPrintFiles when calling submitOrder. This keeps the
// service honest about what CustomCat actually requires.
// ============================================================

import fetch from 'node-fetch';
import type { AppConfig, Order, OrderLineItem, OrderStatus, ProductSize } from '../../types/index.js';
import { CustomCatError } from '../../utils/errors.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('customcat');

// ============================================================
// Client
// ============================================================

export interface CustomCatClient {
  readonly apiKey: string;
  readonly baseUrl: string;
}

export function createCustomCatClient(config: AppConfig['customcat']): CustomCatClient {
  return {
    apiKey: config.apiKey,
    baseUrl: config.apiUrl,
  };
}

// ============================================================
// CustomCat API response shapes (CC-prefixed)
// ============================================================

interface CCShippingAddress {
  name: string;
  address1: string;
  address2: string | null;
  city: string;
  state: string;
  zip: string;
  country: string;
}

interface CCLineItem {
  sku: string;
  quantity: number;
  size: string;
  color: string;
  print_files: {
    front: string;
    back: string | null;
  };
}

interface CCOrderRequest {
  external_id: string;
  shipping_address: CCShippingAddress;
  line_items: CCLineItem[];
}

interface CCOrderResponse {
  id: string;
  external_id: string;
  status: string;
  created_at: string;
}

interface CCOrderStatusResponse {
  id: string;
  status: string;
  updated_at: string;
}

interface CCTrackingResponse {
  order_id: string;
  tracking_number: string | null;
  tracking_url: string | null;
  carrier: string | null;
}

interface CCProductVariant {
  id: string;
  sku: string;
  size: string;
  color: string;
  price: number;
  available: boolean;
}

interface CCProduct {
  id: string;
  name: string;
  style_number: string;
  brand: string;
  variants: CCProductVariant[];
}

interface CCProductListResponse {
  products: CCProduct[];
  total: number;
}

interface CCPrintArea {
  name: string;
  width: number;
  height: number;
  unit: string;
}

interface CCPrintAreaResponse {
  product_id: string;
  print_areas: CCPrintArea[];
}

// ============================================================
// Public supplementary types
// ============================================================

/**
 * Augments OrderLineItem with resolved print file URLs.
 * CustomCat requires actual URLs; the base OrderLineItem only carries designId.
 * Callers are responsible for resolving these before calling submitOrder.
 */
export interface OrderLineItemWithPrintFiles extends OrderLineItem {
  readonly frontPrintFileUrl: string;
  readonly backPrintFileUrl: string | null;
}

export interface TrackingInfo {
  readonly trackingNumber: string | null;
  readonly trackingUrl: string | null;
  readonly carrier: string | null;
}

export interface ProductCatalogItem {
  readonly id: string;
  readonly name: string;
  readonly styleNumber: string;
  readonly brand: string;
  readonly variants: ReadonlyArray<{
    readonly id: string;
    readonly sku: string;
    readonly size: ProductSize;
    readonly color: string;
    readonly price: number;
    readonly available: boolean;
  }>;
}

export interface PrintAreaSpec {
  readonly name: string;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly unit: string;
}

// ============================================================
// Internal fetch wrapper
// ============================================================

async function customCatFetch<T>(
  client: CustomCatClient,
  endpoint: string,
  options?: { method?: string; body?: unknown },
): Promise<T> {
  const method = options?.method ?? 'GET';
  const url = `${client.baseUrl}${endpoint}`;

  logger.info({ method, url }, 'CustomCat API request');

  let response: Awaited<ReturnType<typeof fetch>>;
  try {
    response = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-API-Key': client.apiKey,
      },
      body: options?.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ method, url, error: message }, 'CustomCat network error');
    throw new CustomCatError(`Network error calling CustomCat [${method} ${endpoint}]: ${message}`);
  }

  if (!response.ok) {
    let errorBody = '';
    try {
      errorBody = await response.text();
    } catch {
      // best-effort — ignore parse failure on error body
    }
    logger.error(
      { method, url, status: response.status, body: errorBody },
      'CustomCat API error response',
    );
    throw new CustomCatError(
      `CustomCat API error [${method} ${endpoint}]: HTTP ${String(response.status)} — ${errorBody}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ method, url, error: message }, 'CustomCat response parse error');
    throw new CustomCatError(`Failed to parse CustomCat response [${method} ${endpoint}]: ${message}`);
  }

  logger.info({ method, url, status: response.status }, 'CustomCat API response received');
  return parsed as T;
}

// ============================================================
// Order submission
// ============================================================

function mapShippingAddress(address: Order['shippingAddress']): CCShippingAddress {
  return {
    name: address.name,
    address1: address.address1,
    address2: address.address2,
    city: address.city,
    state: address.province,
    zip: address.zip,
    country: address.country,
  };
}

function mapLineItem(item: OrderLineItemWithPrintFiles): CCLineItem {
  return {
    sku: item.sku,
    quantity: item.quantity,
    size: item.size,
    color: item.color,
    print_files: {
      front: item.frontPrintFileUrl,
      back: item.backPrintFileUrl,
    },
  };
}

/**
 * Submits an order to CustomCat for fulfillment.
 * Returns the CustomCat-assigned order ID.
 *
 * lineItems must include resolved print file URLs. The base Order type only
 * carries designId; callers must resolve URLs before calling this function.
 */
export async function submitOrder(
  client: CustomCatClient,
  order: Order,
  lineItems: ReadonlyArray<OrderLineItemWithPrintFiles>,
): Promise<string> {
  if (lineItems.length === 0) {
    throw new CustomCatError(`Cannot submit order ${order.id}: line items array is empty`);
  }

  const payload: CCOrderRequest = {
    external_id: order.shopifyOrderId,
    shipping_address: mapShippingAddress(order.shippingAddress),
    line_items: lineItems.map(mapLineItem),
  };

  logger.info(
    { orderId: order.id, shopifyOrderId: order.shopifyOrderId, lineItemCount: lineItems.length },
    'Submitting order to CustomCat',
  );

  const response = await customCatFetch<CCOrderResponse>(client, '/orders', {
    method: 'POST',
    body: payload,
  });

  if (!response.id) {
    throw new CustomCatError(
      `CustomCat order submission for ${order.id} returned no order ID in response`,
    );
  }

  logger.info(
    { orderId: order.id, customcatOrderId: response.id },
    'Order successfully submitted to CustomCat',
  );

  return response.id;
}

// ============================================================
// Order status
// ============================================================

const CC_STATUS_MAP: Readonly<Record<string, OrderStatus>> = {
  received: 'received',
  pending: 'received',
  processing: 'in_production',
  in_production: 'in_production',
  printed: 'in_production',
  shipped: 'shipped',
  delivered: 'delivered',
  cancelled: 'cancelled',
  error: 'error',
  failed: 'error',
};

function mapCCStatus(ccStatus: string): OrderStatus {
  const normalized = ccStatus.toLowerCase().trim();
  const mapped = CC_STATUS_MAP[normalized];
  if (mapped === undefined) {
    logger.warn(
      { ccStatus },
      'Unrecognised CustomCat order status — defaulting to "error"',
    );
    return 'error';
  }
  return mapped;
}

/**
 * Fetches the current status of a CustomCat order and maps it to our OrderStatus type.
 */
export async function getOrderStatus(
  client: CustomCatClient,
  customcatOrderId: string,
): Promise<OrderStatus> {
  logger.info({ customcatOrderId }, 'Fetching order status from CustomCat');

  const response = await customCatFetch<CCOrderStatusResponse>(
    client,
    `/orders/${customcatOrderId}`,
  );

  const status = mapCCStatus(response.status);

  logger.info({ customcatOrderId, ccStatus: response.status, mappedStatus: status }, 'Order status fetched');

  return status;
}

// ============================================================
// Tracking
// ============================================================

/**
 * Fetches tracking number and URL for a fulfilled CustomCat order.
 * Returns null fields if the order has not yet shipped.
 */
export async function getTrackingInfo(
  client: CustomCatClient,
  customcatOrderId: string,
): Promise<TrackingInfo> {
  logger.info({ customcatOrderId }, 'Fetching tracking info from CustomCat');

  const response = await customCatFetch<CCTrackingResponse>(
    client,
    `/orders/${customcatOrderId}/tracking`,
  );

  const result: TrackingInfo = {
    trackingNumber: response.tracking_number,
    trackingUrl: response.tracking_url,
    carrier: response.carrier,
  };

  logger.info(
    { customcatOrderId, hasTracking: response.tracking_number !== null },
    'Tracking info fetched',
  );

  return result;
}

// ============================================================
// Product catalog
// ============================================================

const BELLA_CANVAS_3001_STYLE = '3001';
const BELLA_CANVAS_BRAND = 'Bella+Canvas';

const VALID_SIZES: ReadonlySet<string> = new Set<ProductSize>([
  'XS', 'S', 'M', 'L', 'XL', '2XL', '3XL',
]);

function isProductSize(value: string): value is ProductSize {
  return VALID_SIZES.has(value);
}

function mapCCVariant(
  variant: CCProductVariant,
): ProductCatalogItem['variants'][number] | null {
  const size = variant.size.toUpperCase();
  if (!isProductSize(size)) {
    logger.warn({ sku: variant.sku, size: variant.size }, 'Skipping variant with unrecognised size');
    return null;
  }
  return {
    id: variant.id,
    sku: variant.sku,
    size,
    color: variant.color,
    price: variant.price,
    available: variant.available,
  };
}

function mapCCProduct(product: CCProduct): ProductCatalogItem {
  const mappedVariants = product.variants
    .map(mapCCVariant)
    .filter((v): v is NonNullable<typeof v> => v !== null);

  return {
    id: product.id,
    name: product.name,
    styleNumber: product.style_number,
    brand: product.brand,
    variants: mappedVariants,
  };
}

/**
 * Fetches available Bella+Canvas 3001 product variants from the CustomCat catalog.
 * Filters to only BC 3001 products and drops variants with sizes outside our ProductSize enum.
 */
export async function getProductCatalog(client: CustomCatClient): Promise<ReadonlyArray<ProductCatalogItem>> {
  logger.info({ brand: BELLA_CANVAS_BRAND, style: BELLA_CANVAS_3001_STYLE }, 'Fetching product catalog from CustomCat');

  const response = await customCatFetch<CCProductListResponse>(
    client,
    `/products?brand=Bella%2BCanvas&style=${BELLA_CANVAS_3001_STYLE}`,
  );

  const filtered = response.products
    .filter(
      (p) =>
        p.brand.toLowerCase() === BELLA_CANVAS_BRAND.toLowerCase() &&
        p.style_number === BELLA_CANVAS_3001_STYLE,
    )
    .map(mapCCProduct);

  logger.info(
    { totalReturned: response.products.length, filteredCount: filtered.length },
    'Product catalog fetched',
  );

  return filtered;
}

// ============================================================
// Print area specs
// ============================================================

/**
 * Fetches print area dimensions for a specific CustomCat product.
 */
export async function getPrintAreaSpecs(
  client: CustomCatClient,
  productId: string,
): Promise<ReadonlyArray<PrintAreaSpec>> {
  logger.info({ productId }, 'Fetching print area specs from CustomCat');

  const response = await customCatFetch<CCPrintAreaResponse>(
    client,
    `/products/${productId}/print-areas`,
  );

  const specs: PrintAreaSpec[] = response.print_areas.map((area) => ({
    name: area.name,
    widthPx: area.width,
    heightPx: area.height,
    unit: area.unit,
  }));

  logger.info({ productId, areaCount: specs.length }, 'Print area specs fetched');

  return specs;
}
