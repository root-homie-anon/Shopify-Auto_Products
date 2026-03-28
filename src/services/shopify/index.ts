// ============================================================
// Shopify Service
// Wraps the Shopify Admin API for Banyakob apparel product management.
// All functions are pure/functional — no class state beyond the client
// connector from shopify-api-node.
// ============================================================

import Shopify from 'shopify-api-node';

import { createLogger } from '../../utils/logger.js';
import { ShopifyError } from '../../utils/errors.js';

import type { AppConfig, Product, ProductStatus } from '../../types/index.js';

// ----------------------------------------------------------------
// Local types
// ----------------------------------------------------------------

/**
 * A rule for a smart collection. Column/relation/condition mirror the
 * Shopify Admin API shape verbatim so the caller works with the same
 * vocabulary as the API docs.
 */
export interface CollectionRule {
  column:
    | 'title'
    | 'tag'
    | 'type'
    | 'variant_title'
    | 'vendor'
    | 'variant_compare_at_price'
    | 'variant_inventory'
    | 'variant_price'
    | 'variant_weight';
  relation:
    | 'contains'
    | 'equals'
    | 'ends_with'
    | 'not_contains'
    | 'not_equals'
    | 'starts_with'
    | 'greater_than'
    | 'less_than';
  condition: string;
}

/**
 * Union return type for createCollection — callers receive whichever
 * Shopify collection type was actually created.
 */
export type ShopifyCollection =
  | Shopify.ICustomCollection
  | Shopify.ISmartCollection;

// ----------------------------------------------------------------
// Module-level logger
// ----------------------------------------------------------------

const logger = createLogger('shopify-service');

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------

/**
 * Normalises an unknown thrown value into a useful ShopifyError.
 * shopify-api-node throws plain Error objects with a message that
 * may include the HTTP status, so we preserve the original message
 * and append any extra context we have.
 */
function toShopifyError(context: string, cause: unknown): ShopifyError {
  const message =
    cause instanceof Error
      ? `${context}: ${cause.message}`
      : `${context}: unknown error`;
  return new ShopifyError(message);
}

/**
 * Maps our internal ProductVariant shape onto the Shopify variant
 * create/update payload. Both Size and Color are encoded as option
 * values to keep the variant grid Shopify-native.
 */
function mapVariantToShopify(
  variant: Product['variants'][number],
): Record<string, string | number | boolean | null> {
  return {
    option1: variant.size,
    option2: variant.color,
    sku: variant.sku,
    price: variant.price.toFixed(2),
    compare_at_price:
      variant.compareAtPrice !== null
        ? variant.compareAtPrice.toFixed(2)
        : null,
    inventory_quantity: variant.inventoryQuantity,
    inventory_management: 'shopify',
    requires_shipping: true,
    taxable: true,
  };
}

/**
 * Builds the product options array from the variant grid so Shopify
 * knows which option axes exist.
 */
function buildProductOptions(
  variants: Product['variants'],
): Array<{ name: string; values: string[] }> {
  const sizes = [...new Set(variants.map((v) => v.size))];
  const colors = [...new Set(variants.map((v) => v.color))];
  return [
    { name: 'Size', values: sizes },
    { name: 'Color', values: colors },
  ];
}

// ----------------------------------------------------------------
// 1. createShopifyClient
// ----------------------------------------------------------------

/**
 * Constructs and returns an authenticated Shopify API client.
 * Uses the public-app / access-token flow.
 */
export function createShopifyClient(
  config: AppConfig['shopify'],
): InstanceType<typeof Shopify> {
  logger.info({ shopName: config.shopName }, 'Initialising Shopify client');
  return new Shopify({
    shopName: config.shopName,
    accessToken: config.accessToken,
    autoLimit: true,
  });
}

// ----------------------------------------------------------------
// 2. createProduct
// ----------------------------------------------------------------

/**
 * Creates a product on Shopify including all variants, design images,
 * tags, and SEO metadata derived from the product's design and listing
 * copy fields.
 *
 * Returns the Shopify numeric product ID as a string so it can be
 * persisted back to our Product record's shopifyId field.
 */
export async function createProduct(
  client: InstanceType<typeof Shopify>,
  product: Product,
): Promise<string> {
  logger.info(
    { productId: product.id, title: product.title },
    'Creating Shopify product',
  );

  const images: Array<{ src: string; alt: string }> = [
    { src: product.design.frontImageUrl, alt: `${product.title} — front` },
  ];

  if (product.design.backImageUrl !== null) {
    images.push({
      src: product.design.backImageUrl,
      alt: `${product.title} — back`,
    });
  }

  const payload = {
    title: product.title,
    body_html: product.description,
    vendor: product.vendor,
    product_type: product.productType,
    tags: product.tags.join(', '),
    status: product.status,
    options: buildProductOptions(product.variants),
    variants: product.variants.map(mapVariantToShopify),
    images,
    metafields_global_title_tag: product.title,
    metafields_global_description_tag: product.description.slice(0, 320),
  };

  try {
    const created = await client.product.create(payload);
    logger.info(
      { productId: product.id, shopifyId: created.id },
      'Shopify product created',
    );
    return String(created.id);
  } catch (err) {
    logger.error(
      { productId: product.id, err },
      'Failed to create Shopify product',
    );
    throw toShopifyError(`createProduct(${product.id})`, err);
  }
}

// ----------------------------------------------------------------
// 3. updateProduct
// ----------------------------------------------------------------

/**
 * Applies a partial update to an existing Shopify product. Only the
 * fields present in the updates object are sent to the API — Shopify
 * does a merge on its end for top-level fields.
 *
 * Variant updates are not supported here; use the productVariant
 * resource directly for variant-level changes.
 */
export async function updateProduct(
  client: InstanceType<typeof Shopify>,
  shopifyId: string,
  updates: Partial<Product>,
): Promise<Shopify.IProduct> {
  logger.info({ shopifyId }, 'Updating Shopify product');

  const payload: Record<string, unknown> = {};

  if (updates.title !== undefined) payload['title'] = updates.title;
  if (updates.description !== undefined)
    payload['body_html'] = updates.description;
  if (updates.vendor !== undefined) payload['vendor'] = updates.vendor;
  if (updates.productType !== undefined)
    payload['product_type'] = updates.productType;
  if (updates.tags !== undefined) payload['tags'] = updates.tags.join(', ');
  if (updates.status !== undefined) payload['status'] = updates.status;

  // Re-map variants if provided
  if (updates.variants !== undefined) {
    payload['variants'] = updates.variants.map(mapVariantToShopify);
    payload['options'] = buildProductOptions(updates.variants);
  }

  try {
    const updated = await client.product.update(Number(shopifyId), payload);
    logger.info({ shopifyId }, 'Shopify product updated');
    return updated;
  } catch (err) {
    logger.error({ shopifyId, err }, 'Failed to update Shopify product');
    throw toShopifyError(`updateProduct(${shopifyId})`, err);
  }
}

// ----------------------------------------------------------------
// 4. getProduct
// ----------------------------------------------------------------

/**
 * Fetches a single product from Shopify by its numeric ID.
 */
export async function getProduct(
  client: InstanceType<typeof Shopify>,
  shopifyId: string,
): Promise<Shopify.IProduct> {
  logger.info({ shopifyId }, 'Fetching Shopify product');

  try {
    const product = await client.product.get(Number(shopifyId));
    logger.info({ shopifyId }, 'Shopify product fetched');
    return product;
  } catch (err) {
    logger.error({ shopifyId, err }, 'Failed to fetch Shopify product');
    throw toShopifyError(`getProduct(${shopifyId})`, err);
  }
}

// ----------------------------------------------------------------
// 5. listProducts
// ----------------------------------------------------------------

/**
 * Lists products with optional limit and status filters.
 * Returns the raw paginated result from shopify-api-node so the caller
 * can handle cursor-based pagination if needed.
 */
export async function listProducts(
  client: InstanceType<typeof Shopify>,
  params?: { limit?: number; status?: ProductStatus },
): Promise<Shopify.IPaginatedResult<Shopify.IProduct>> {
  const query: Record<string, unknown> = {};
  if (params?.limit !== undefined) query['limit'] = params.limit;
  if (params?.status !== undefined) query['status'] = params.status;

  logger.info({ params }, 'Listing Shopify products');

  try {
    const result = await client.product.list(query);
    logger.info(
      { count: result.length },
      'Shopify products listed',
    );
    return result;
  } catch (err) {
    logger.error({ params, err }, 'Failed to list Shopify products');
    throw toShopifyError('listProducts', err);
  }
}

// ----------------------------------------------------------------
// 6. createCollection
// ----------------------------------------------------------------

/**
 * Creates a Shopify collection.
 *
 * - If `rules` is provided and non-empty, a smart collection is created
 *   using those rules (automatic membership).
 * - If `rules` is omitted or empty, a custom collection is created
 *   (manual product assignment).
 *
 * Returns the created collection object. The id field on the return
 * value is the Shopify numeric collection ID.
 */
export async function createCollection(
  client: InstanceType<typeof Shopify>,
  title: string,
  rules?: CollectionRule[],
): Promise<ShopifyCollection> {
  const hasSmart = rules !== undefined && rules.length > 0;

  logger.info(
    { title, type: hasSmart ? 'smart' : 'custom' },
    'Creating Shopify collection',
  );

  try {
    if (hasSmart) {
      const created = await client.smartCollection.create({ title, rules });
      logger.info(
        { title, shopifyCollectionId: created.id },
        'Shopify smart collection created',
      );
      return created;
    }

    const created = await client.customCollection.create({ title });
    logger.info(
      { title, shopifyCollectionId: created.id },
      'Shopify custom collection created',
    );
    return created;
  } catch (err) {
    logger.error({ title, err }, 'Failed to create Shopify collection');
    throw toShopifyError(`createCollection(${title})`, err);
  }
}

// ----------------------------------------------------------------
// 7. getOrders
// ----------------------------------------------------------------

/**
 * Fetches orders from Shopify with optional filters.
 *
 * `since_id` enables cursor-style forward pagination — pass the last
 * seen order ID to retrieve only newer orders.
 */
export async function getOrders(
  client: InstanceType<typeof Shopify>,
  params?: { status?: string; limit?: number; since_id?: string },
): Promise<Shopify.IPaginatedResult<Shopify.IOrder>> {
  const query: Record<string, unknown> = {};
  if (params?.status !== undefined) query['status'] = params.status;
  if (params?.limit !== undefined) query['limit'] = params.limit;
  if (params?.since_id !== undefined) query['since_id'] = params.since_id;

  logger.info({ params }, 'Fetching Shopify orders');

  try {
    const result = await client.order.list(query);
    logger.info({ count: result.length }, 'Shopify orders fetched');
    return result;
  } catch (err) {
    logger.error({ params, err }, 'Failed to fetch Shopify orders');
    throw toShopifyError('getOrders', err);
  }
}

// ----------------------------------------------------------------
// 8. updateOrderTracking
// ----------------------------------------------------------------

/**
 * Updates the tracking information on a fulfillment.
 *
 * Flow:
 *  1. List fulfillments for the order.
 *  2. Take the first open/pending fulfillment (Shopify creates one
 *     automatically when an order is marked as fulfilled).
 *  3. Call fulfillment.updateTracking with the new tracking data.
 *
 * Throws ShopifyError if no fulfillment is found for the order.
 */
export async function updateOrderTracking(
  client: InstanceType<typeof Shopify>,
  orderId: string,
  trackingNumber: string,
  trackingUrl: string,
): Promise<Shopify.IFulfillment> {
  logger.info({ orderId, trackingNumber }, 'Updating order tracking');

  let fulfillments: Shopify.IPaginatedResult<Shopify.IFulfillment>;

  try {
    fulfillments = await client.fulfillment.list(Number(orderId));
  } catch (err) {
    logger.error({ orderId, err }, 'Failed to list fulfillments for order');
    throw toShopifyError(
      `updateOrderTracking — list fulfillments(${orderId})`,
      err,
    );
  }

  const fulfillment = fulfillments[0];

  if (fulfillment === undefined) {
    throw new ShopifyError(
      `updateOrderTracking: no fulfillments found for order ${orderId}`,
    );
  }

  try {
    const updated = await client.fulfillment.updateTracking(fulfillment.id, {
      tracking_info: {
        number: trackingNumber,
        url: trackingUrl,
      },
      notify_customer: true,
    });

    logger.info(
      { orderId, fulfillmentId: fulfillment.id, trackingNumber },
      'Order tracking updated',
    );

    return updated;
  } catch (err) {
    logger.error(
      { orderId, fulfillmentId: fulfillment.id, err },
      'Failed to update order tracking',
    );
    throw toShopifyError(
      `updateOrderTracking — updateTracking(fulfillment=${String(fulfillment.id)})`,
      err,
    );
  }
}
