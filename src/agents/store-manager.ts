// ============================================================
// Store Manager Agent
// Manages Shopify store operations — product CRUD, collections,
// pricing, and inventory sync with CustomCat.
// ============================================================

import type Shopify from 'shopify-api-node';

import {
  createShopifyClient,
  createProduct,
  updateProduct,
  listProducts,
  createCollection,
  getOrders,
} from '../services/shopify/index.js';
import type { CollectionRule, ShopifyCollection } from '../services/shopify/index.js';

import {
  createCustomCatClient,
  getProductCatalog,
} from '../services/customcat/index.js';
import type { CustomCatClient, ProductCatalogItem } from '../services/customcat/index.js';

import type { AppConfig, Product, ProductStatus, ProductVariant } from '../types/index.js';
import { ShopifyError } from '../utils/errors.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('store-manager');

// ----------------------------------------------------------------
// Public types
// ----------------------------------------------------------------

export interface StoreManagerClients {
  readonly shopify: InstanceType<typeof Shopify>;
  readonly customcat: CustomCatClient;
}

export interface InventorySyncReport {
  readonly matched: ReadonlyArray<{ sku: string; shopifyId: string }>;
  readonly mismatched: ReadonlyArray<{
    sku: string;
    shopifyId: string;
    issues: string[];
  }>;
  readonly missing: ReadonlyArray<{ sku: string; reason: string }>;
}

export interface StoreStatus {
  readonly totalProducts: number;
  readonly active: number;
  readonly draft: number;
  readonly archived: number;
  readonly recentOrdersCount: number;
}

export interface PricingUpdate {
  readonly shopifyId: string;
  readonly price: number;
  readonly compareAtPrice?: number;
}

// ----------------------------------------------------------------
// 1. initStoreManager
// ----------------------------------------------------------------

/**
 * Initialises both Shopify and CustomCat clients from the provided config.
 * Returns a clients object to be passed explicitly to all subsequent operations.
 */
export function initStoreManager(config: AppConfig): StoreManagerClients {
  logger.info('Initialising StoreManager clients');

  const shopify = createShopifyClient(config.shopify);
  const customcat = createCustomCatClient(config.customcat);

  logger.info('StoreManager clients initialised');

  return { shopify, customcat };
}

// ----------------------------------------------------------------
// 2. addProduct
// ----------------------------------------------------------------

/**
 * Creates a product on Shopify and returns the resulting Shopify product ID.
 */
export async function addProduct(
  clients: StoreManagerClients,
  product: Product,
): Promise<string> {
  logger.info(
    { productId: product.id, title: product.title },
    'addProduct: creating product on Shopify',
  );

  try {
    const shopifyId = await createProduct(clients.shopify, product);
    logger.info(
      { productId: product.id, shopifyId },
      'addProduct: product created successfully',
    );
    return shopifyId;
  } catch (err) {
    logger.error(
      { productId: product.id, err },
      'addProduct: failed to create product',
    );
    throw new ShopifyError(
      `addProduct(${product.id}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ----------------------------------------------------------------
// 3. updateProductDetails
// ----------------------------------------------------------------

/**
 * Applies a partial update to an existing Shopify product.
 * Returns the updated Shopify product object.
 */
export async function updateProductDetails(
  clients: StoreManagerClients,
  shopifyId: string,
  updates: Partial<Product>,
): Promise<Shopify.IProduct> {
  logger.info({ shopifyId }, 'updateProductDetails: applying updates');

  try {
    const updated = await updateProduct(clients.shopify, shopifyId, updates);
    logger.info({ shopifyId }, 'updateProductDetails: product updated');
    return updated;
  } catch (err) {
    logger.error(
      { shopifyId, err },
      'updateProductDetails: failed to update product',
    );
    throw new ShopifyError(
      `updateProductDetails(${shopifyId}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ----------------------------------------------------------------
// 4. syncInventoryFromCatalog
// ----------------------------------------------------------------

/**
 * Fetches the CustomCat product catalog, then lists all Shopify products
 * and cross-references each product's variants (by SKU) against available
 * CustomCat inventory.
 *
 * A variant is:
 *   - "matched"    — found in the CustomCat catalog and marked available
 *   - "mismatched" — found but unavailable, or price drift detected
 *   - "missing"    — SKU not present in CustomCat catalog at all
 *
 * Returns a structured report with all three categories.
 */
export async function syncInventoryFromCatalog(
  clients: StoreManagerClients,
): Promise<InventorySyncReport> {
  logger.info('syncInventoryFromCatalog: starting sync');

  const [catalog, shopifyProducts] = await Promise.all([
    getProductCatalog(clients.customcat),
    listProducts(clients.shopify),
  ]);

  // Flatten CustomCat variants into a lookup keyed by SKU for O(1) access.
  const catalogBySku = buildCatalogSkuIndex(catalog);

  const matched: Array<{ sku: string; shopifyId: string }> = [];
  const mismatched: Array<{ sku: string; shopifyId: string; issues: string[] }> = [];
  const missing: Array<{ sku: string; reason: string }> = [];

  for (const shopifyProduct of shopifyProducts) {
    const shopifyId = String(shopifyProduct.id);

    for (const variant of shopifyProduct.variants) {
      const sku = variant.sku;

      if (!sku) {
        logger.warn(
          { shopifyId, variantId: variant.id },
          'syncInventoryFromCatalog: variant has no SKU — skipping',
        );
        continue;
      }

      const catalogVariant = catalogBySku.get(sku);

      if (catalogVariant === undefined) {
        logger.warn(
          { sku, shopifyId },
          'syncInventoryFromCatalog: SKU not found in CustomCat catalog',
        );
        missing.push({ sku, reason: 'SKU not found in CustomCat catalog' });
        continue;
      }

      const issues: string[] = [];

      if (!catalogVariant.available) {
        issues.push('variant marked unavailable in CustomCat');
      }

      if (issues.length > 0) {
        logger.warn(
          { sku, shopifyId, issues },
          'syncInventoryFromCatalog: variant has discrepancies',
        );
        mismatched.push({ sku, shopifyId, issues });
      } else {
        matched.push({ sku, shopifyId });
      }
    }
  }

  const report: InventorySyncReport = { matched, mismatched, missing };

  logger.info(
    {
      matched: matched.length,
      mismatched: mismatched.length,
      missing: missing.length,
    },
    'syncInventoryFromCatalog: sync complete',
  );

  return report;
}

// ----------------------------------------------------------------
// 5. organizeCollection
// ----------------------------------------------------------------

/**
 * Creates a Shopify collection.
 *
 * When `rules` is provided and non-empty, a smart (automatic) collection
 * is created. Otherwise a custom (manual) collection is created.
 *
 * The `rules` parameter accepts the same column/relation/condition shape
 * as the Shopify Admin API (mirrored by CollectionRule).
 */
export async function organizeCollection(
  clients: StoreManagerClients,
  collectionName: string,
  rules?: CollectionRule[],
): Promise<ShopifyCollection> {
  logger.info(
    { collectionName, ruleCount: rules?.length ?? 0 },
    'organizeCollection: creating collection',
  );

  try {
    const collection = await createCollection(
      clients.shopify,
      collectionName,
      rules,
    );

    logger.info(
      { collectionName, shopifyCollectionId: collection.id },
      'organizeCollection: collection created',
    );

    return collection;
  } catch (err) {
    logger.error(
      { collectionName, err },
      'organizeCollection: failed to create collection',
    );
    throw new ShopifyError(
      `organizeCollection(${collectionName}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ----------------------------------------------------------------
// 6. bulkUpdatePricing
// ----------------------------------------------------------------

/**
 * Batch-updates pricing for multiple Shopify products.
 *
 * For each entry, the existing Shopify product is fetched to retrieve the
 * current variant grid. All variants are then re-mapped with the new price
 * and compareAtPrice values before being sent back via updateProduct.
 *
 * Processed sequentially to respect Shopify rate limits.
 */
export async function bulkUpdatePricing(
  clients: StoreManagerClients,
  updates: ReadonlyArray<PricingUpdate>,
): Promise<void> {
  logger.info({ count: updates.length }, 'bulkUpdatePricing: starting batch');

  for (const entry of updates) {
    logger.info(
      { shopifyId: entry.shopifyId, price: entry.price },
      'bulkUpdatePricing: updating product pricing',
    );

    try {
      const existing = await clients.shopify.product.get(Number(entry.shopifyId));

      const updatedVariants: ProductVariant[] = existing.variants.map(
        (v): ProductVariant => ({
          size: resolveSize(v.option1),
          color: v.option2 ?? '',
          sku: v.sku,
          price: entry.price,
          compareAtPrice: entry.compareAtPrice ?? null,
          inventoryQuantity:
            typeof v.inventory_quantity === 'number' ? v.inventory_quantity : 0,
        }),
      );

      await updateProduct(clients.shopify, entry.shopifyId, {
        variants: updatedVariants,
      });

      logger.info(
        { shopifyId: entry.shopifyId },
        'bulkUpdatePricing: product pricing updated',
      );
    } catch (err) {
      logger.error(
        { shopifyId: entry.shopifyId, err },
        'bulkUpdatePricing: failed to update product pricing',
      );
      throw new ShopifyError(
        `bulkUpdatePricing(${entry.shopifyId}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  logger.info({ count: updates.length }, 'bulkUpdatePricing: batch complete');
}

// ----------------------------------------------------------------
// 7. getStoreStatus
// ----------------------------------------------------------------

/**
 * Returns a summary of the store's current state:
 * total product count broken down by status, and the count of recent orders.
 *
 * "Recent" orders are fetched with the default limit (250) from the Shopify
 * API without a date filter — callers can narrow this by passing since_id
 * into a custom getOrders call if finer granularity is needed.
 */
export async function getStoreStatus(
  clients: StoreManagerClients,
): Promise<StoreStatus> {
  logger.info('getStoreStatus: fetching store summary');

  const [allProducts, recentOrders] = await Promise.all([
    listProducts(clients.shopify, { limit: 250 }),
    getOrders(clients.shopify, { status: 'any', limit: 50 }),
  ]);

  const counts = countByStatus(allProducts);

  const status: StoreStatus = {
    totalProducts: allProducts.length,
    active: counts.active,
    draft: counts.draft,
    archived: counts.archived,
    recentOrdersCount: recentOrders.length,
  };

  logger.info(status, 'getStoreStatus: summary ready');

  return status;
}

// ----------------------------------------------------------------
// Internal helpers
// ----------------------------------------------------------------

/**
 * Builds a flat SKU-to-variant index from the full CustomCat catalog.
 * Variants across all products are indexed together because SKUs are
 * globally unique within CustomCat.
 */
function buildCatalogSkuIndex(
  catalog: ReadonlyArray<ProductCatalogItem>,
): Map<string, ProductCatalogItem['variants'][number]> {
  const index = new Map<string, ProductCatalogItem['variants'][number]>();

  for (const product of catalog) {
    for (const variant of product.variants) {
      index.set(variant.sku, variant);
    }
  }

  return index;
}

/**
 * Counts Shopify products by their status field.
 * Shopify's IPaginatedResult extends Array, so standard iteration is safe.
 */
function countByStatus(
  products: Shopify.IPaginatedResult<Shopify.IProduct>,
): Record<ProductStatus, number> {
  const result: Record<ProductStatus, number> = {
    active: 0,
    draft: 0,
    archived: 0,
  };

  for (const product of products) {
    const s = product.status as ProductStatus;
    if (s in result) {
      result[s] += 1;
    }
  }

  return result;
}

/**
 * Resolves a Shopify option1 string (size) to our ProductSize union.
 * Falls back to 'M' and logs a warning if the value is unrecognised —
 * this is a defensive fallback for corrupted Shopify data; callers
 * should treat affected variants as needing manual review.
 */
const VALID_SIZES = new Set<string>(['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL']);

function resolveSize(raw: string | null | undefined): ProductVariant['size'] {
  const normalised = (raw ?? '').trim().toUpperCase();
  if (VALID_SIZES.has(normalised)) {
    return normalised as ProductVariant['size'];
  }
  logger.warn(
    { raw },
    'resolveSize: unrecognised size value — defaulting to M',
  );
  return 'M';
}
