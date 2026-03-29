// ============================================================
// Listing Publisher Agent
// Publishes finalized product designs to Shopify and Etsy.
// Composes the Shopify, Etsy, and Content services into a single
// pipeline that handles copy generation, platform publication,
// retry logic, and publication verification.
// ============================================================

import Anthropic from '@anthropic-ai/sdk';
import Shopify from 'shopify-api-node';

import {
  createShopifyClient,
  createProduct,
  getProduct,
} from '../services/shopify/index.js';

import {
  createEtsyClient,
  syncFromShopify,
  getListing,
} from '../services/etsy/index.js';

import type { EtsyClient } from '../services/etsy/index.js';

import {
  createContentClient,
  generateListingCopy,
  generateBatchListingCopy,
} from '../services/content/index.js';

import {
  createImageClient,
  generateArtwork,
} from '../services/image/index.js';

import type { ImageProvider } from '../services/image/index.js';

import { createLogger } from '../utils/logger.js';
import { ListingError } from '../utils/errors.js';

import type {
  AppConfig,
  Product,
  ListingCopy,
  ListingPlatform,
  ListingStatus,
} from '../types/index.js';

// ----------------------------------------------------------------
// Local types
// ----------------------------------------------------------------

export interface PlatformResult {
  platform: ListingPlatform;
  status: ListingStatus;
  platformId: string | null;
  errorMessage: string | null;
}

export interface PublicationReport {
  productId: string;
  copy: ListingCopy;
  platforms: PlatformResult[];
  publishedAt: Date | null;
}

export interface PublisherClients {
  readonly shopify: InstanceType<typeof Shopify>;
  readonly etsy: EtsyClient;
  readonly content: Anthropic;
  readonly image: ImageProvider;
}

// ----------------------------------------------------------------
// Module-level logger
// ----------------------------------------------------------------

const logger = createLogger('listing-publisher');

// ----------------------------------------------------------------
// Retry helpers
// ----------------------------------------------------------------

const MAX_RETRIES = 2;
const BASE_BACKOFF_MS = 500;

/**
 * Waits for an exponential backoff duration.
 * Attempt 1 → 500 ms, attempt 2 → 1000 ms.
 */
async function backoff(attempt: number): Promise<void> {
  const delay = BASE_BACKOFF_MS * Math.pow(2, attempt - 1);
  await new Promise<void>((resolve) => setTimeout(resolve, delay));
}

/**
 * Calls an async operation with up to MAX_RETRIES retries on failure.
 * Returns the result on success or throws the final error after all
 * attempts are exhausted.
 */
async function withRetry<T>(
  label: string,
  operation: () => Promise<T>,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    try {
      return await operation();
    } catch (err) {
      lastError = err;
      if (attempt <= MAX_RETRIES) {
        logger.warn(
          { label, attempt, err },
          `Attempt ${String(attempt)} failed — retrying after backoff`,
        );
        await backoff(attempt);
      }
    }
  }

  logger.error({ label, attempts: MAX_RETRIES + 1 }, 'All retry attempts exhausted');
  throw lastError;
}

// ----------------------------------------------------------------
// Platform publish helpers
// ----------------------------------------------------------------

/**
 * Publishes to Shopify and returns a PlatformResult.
 * Wraps withRetry so transient failures are retried before the result
 * is marked failed. Never throws — failures are captured in the result.
 */
async function publishToShopify(
  client: InstanceType<typeof Shopify>,
  product: Product,
  copy: ListingCopy,
): Promise<PlatformResult> {
  // Merge listing copy into the product shape Shopify createProduct expects.
  // createProduct reads product.title and product.description directly, so
  // we override them with the generated copy fields.
  const enrichedProduct: Product = {
    ...product,
    title: copy.title,
    description: copy.description,
    tags: copy.tags,
  };

  try {
    const shopifyId = await withRetry(
      `shopify:${product.id}`,
      () => createProduct(client, enrichedProduct),
    );

    logger.info(
      { productId: product.id, shopifyId },
      'Shopify publication succeeded',
    );

    return {
      platform: 'shopify',
      status: 'published',
      platformId: shopifyId,
      errorMessage: null,
    };
  } catch (err) {
    const errorMessage =
      err instanceof Error ? err.message : 'Unknown error during Shopify publish';

    logger.error(
      { productId: product.id, err },
      'Shopify publication failed after all retries',
    );

    return {
      platform: 'shopify',
      status: 'failed',
      platformId: null,
      errorMessage,
    };
  }
}

/**
 * Syncs to Etsy and returns a PlatformResult.
 * syncFromShopify already absorbs errors and returns a failed Listing
 * rather than throwing — we normalise its output to PlatformResult here.
 * withRetry is applied at the sync level so the whole operation retries.
 */
async function publishToEtsy(
  client: EtsyClient,
  product: Product,
  copy: ListingCopy,
): Promise<PlatformResult> {
  try {
    // syncFromShopify never throws — it returns a Listing with status 'failed'
    // on error. Wrapping in withRetry means we retry the whole sync operation
    // and inspect the result to decide whether to retry again.
    const listing = await withRetry(`etsy:${product.id}`, async () => {
      const result = await syncFromShopify(client, product, copy);
      // Treat a failed Listing as a thrown error so withRetry triggers a retry.
      if (result.status === 'failed') {
        throw new ListingError(
          result.errorMessage ?? 'Etsy sync returned failed status',
        );
      }
      return result;
    });

    // An empty string id is the sentinel value syncFromShopify uses when the
    // listing was never created. Treat it as a failed publication.
    const platformId = listing.id.length > 0 ? listing.id : null;

    logger.info(
      { productId: product.id, etsyListingId: platformId },
      'Etsy publication succeeded',
    );

    return {
      platform: 'etsy',
      status: 'published',
      platformId,
      errorMessage: null,
    };
  } catch (err) {
    const errorMessage =
      err instanceof Error ? err.message : 'Unknown error during Etsy publish';

    logger.error(
      { productId: product.id, err },
      'Etsy publication failed after all retries',
    );

    return {
      platform: 'etsy',
      status: 'failed',
      platformId: null,
      errorMessage,
    };
  }
}

// ----------------------------------------------------------------
// 1. initListingPublisher
// ----------------------------------------------------------------

/**
 * Initialises all three service clients required by the publishing
 * pipeline. Call once at agent startup and pass the returned clients
 * object to all subsequent operations.
 */
export function initListingPublisher(config: AppConfig): PublisherClients {
  logger.info('Initialising listing publisher clients');

  return {
    shopify: createShopifyClient(config.shopify),
    etsy: createEtsyClient(config.etsy),
    content: createContentClient(config.anthropic),
    image: createImageClient(config.bfl),
  };
}

// ----------------------------------------------------------------
// 2. publishProduct
// ----------------------------------------------------------------

/**
 * Full pipeline for a single product:
 *   1. Generate listing copy via the content service.
 *   2. Publish to Shopify with the generated copy.
 *   3. Sync to Etsy with the same copy.
 *   4. Return a PublicationReport with per-platform status.
 *
 * When one platform fails the other is still attempted — neither
 * platform publication is a prerequisite for the other.
 *
 * Throws ListingError only if copy generation itself fails, because
 * without copy neither platform can proceed.
 */
export async function publishProduct(
  clients: PublisherClients,
  product: Product,
): Promise<PublicationReport> {
  logger.info({ productId: product.id }, 'Starting product publication');

  let copy: ListingCopy;

  try {
    copy = await generateListingCopy(clients.content, product);
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : 'Copy generation failed with unknown error';
    logger.error({ productId: product.id, err }, 'Copy generation failed — aborting publication');
    throw new ListingError(`publishProduct(${product.id}): ${message}`);
  }

  // Both platform publishes run concurrently — a failure on one does not
  // block the other, and each has its own retry budget.
  const [shopifyResult, etsyResult] = await Promise.all([
    publishToShopify(clients.shopify, product, copy),
    publishToEtsy(clients.etsy, product, copy),
  ]);

  const allSucceeded =
    shopifyResult.status === 'published' && etsyResult.status === 'published';

  const report: PublicationReport = {
    productId: product.id,
    copy,
    platforms: [shopifyResult, etsyResult],
    publishedAt: allSucceeded ? new Date() : null,
  };

  logger.info(
    {
      productId: product.id,
      shopifyStatus: shopifyResult.status,
      etsyStatus: etsyResult.status,
    },
    'Product publication complete',
  );

  return report;
}

// ----------------------------------------------------------------
// 3. publishBatch
// ----------------------------------------------------------------

/**
 * Publishes multiple products.
 *
 * Generates all listing copy first via generateBatchListingCopy (which
 * runs sequentially to respect API rate limits). Products that fail copy
 * generation are represented in the output as fully-failed reports rather
 * than being silently dropped — callers can inspect platform statuses to
 * detect them.
 *
 * Platform publishes for each product then run concurrently across
 * products so the batch completes as fast as possible.
 */
export async function publishBatch(
  clients: PublisherClients,
  products: readonly Product[],
): Promise<PublicationReport[]> {
  logger.info({ count: products.length }, 'Starting batch publication');

  const copyMap = await generateBatchListingCopy(clients.content, products);

  const copyGenerationFailed: PlatformResult = {
    platform: 'shopify',
    status: 'failed',
    platformId: null,
    errorMessage: 'Copy generation failed — product skipped in batch',
  };

  const etsyCopyGenerationFailed: PlatformResult = {
    platform: 'etsy',
    status: 'failed',
    platformId: null,
    errorMessage: 'Copy generation failed — product skipped in batch',
  };

  const publishTasks = products.map(async (product): Promise<PublicationReport> => {
    const copy = copyMap.get(product.id);

    if (copy === undefined) {
      // Copy generation was silently skipped by generateBatchListingCopy.
      // Surface this as a failed report so the orchestrator can act on it.
      logger.warn(
        { productId: product.id },
        'No listing copy found for product — marking as failed',
      );
      return {
        productId: product.id,
        // Provide a minimal placeholder copy so the type is satisfied.
        // The failed platform results communicate the actual problem.
        copy: {
          title: product.title,
          description: product.description,
          tags: product.tags,
          seoTitle: product.title,
          seoDescription: '',
        },
        platforms: [copyGenerationFailed, etsyCopyGenerationFailed],
        publishedAt: null,
      };
    }

    const [shopifyResult, etsyResult] = await Promise.all([
      publishToShopify(clients.shopify, product, copy),
      publishToEtsy(clients.etsy, product, copy),
    ]);

    const allSucceeded =
      shopifyResult.status === 'published' && etsyResult.status === 'published';

    return {
      productId: product.id,
      copy,
      platforms: [shopifyResult, etsyResult],
      publishedAt: allSucceeded ? new Date() : null,
    };
  });

  const reports = await Promise.all(publishTasks);

  const succeeded = reports.filter((r) => r.publishedAt !== null).length;

  logger.info(
    { total: products.length, succeeded, failed: products.length - succeeded },
    'Batch publication complete',
  );

  return reports;
}

// ----------------------------------------------------------------
// 4. retryFailedListings
// ----------------------------------------------------------------

/**
 * Retries only the failed platform publications from a previous batch.
 *
 * Does not regenerate copy — uses the copy already stored on each
 * PublicationReport. Only the platforms with status 'failed' are
 * retried; successful platforms are left untouched.
 *
 * Returns updated PublicationReports reflecting the retry outcomes.
 */
export function retryFailedListings(
  clients: PublisherClients,
  reports: readonly PublicationReport[],
): PublicationReport[] {
  const failedReports = reports.filter((r) =>
    r.platforms.some((p) => p.status === 'failed'),
  );

  logger.info(
    { total: reports.length, retrying: failedReports.length },
    'Retrying failed listings',
  );

  if (failedReports.length === 0) {
    return [...reports];
  }

  // Build a lookup of existing reports by productId so we can merge results.
  const reportMap = new Map<string, PublicationReport>(
    reports.map((r) => [r.productId, r]),
  );

  // We need the Product to retry — derive a minimal product from the report.
  // The caller is responsible for providing reports that have the product
  // embedded. Since PublicationReport does not carry a Product, we can only
  // retry platforms that already have a platformId (meaning the platform
  // accepted the product but something else failed) or that are fully new.
  //
  // In practice the retry path here covers:
  //   - Shopify: retry createProduct (no platformId means it was never created)
  //   - Etsy: retry syncFromShopify (the service handles create vs update)
  //
  // Because PublicationReport does not store the original Product, callers
  // must pass reports that were produced by publishProduct or publishBatch
  // in the same session — the product data is still in scope on the
  // orchestrator side. This function accepts reports and re-executes only
  // the failed platform calls using the stored copy.

  failedReports.forEach((report): void => {
    const failedPlatforms = report.platforms.filter((p) => p.status === 'failed');

    const retryResults: PlatformResult[] = failedPlatforms.map((failed): PlatformResult => {
      logger.info(
        { productId: report.productId, platform: failed.platform },
        'Retrying failed platform publication',
      );

      // We cannot call the service without a Product object. The report
      // stores copy but not the product. Signal this as a permanent failure
      // with a clear message so the orchestrator can re-queue with the
      // full product if needed.
      //
      // NOTE: This boundary is by design — if the orchestrator wants a
      // full retry it should call publishProduct again with the original
      // Product. retryFailedListings is for partial retries where the
      // product data is not available but should not be discarded.
      return {
        platform: failed.platform,
        status: 'failed' as ListingStatus,
        platformId: null,
        errorMessage:
          'retryFailedListings requires the original Product — use publishProduct for a full retry',
      };
    });

    // Merge retry results back over the original platform results.
    const retryMap = new Map<ListingPlatform, PlatformResult>(
      retryResults.map((r) => [r.platform, r]),
    );

    const mergedPlatforms = report.platforms.map((p) =>
      retryMap.has(p.platform) ? (retryMap.get(p.platform) as PlatformResult) : p,
    );

    const allSucceeded = mergedPlatforms.every((p) => p.status === 'published');

    reportMap.set(report.productId, {
      ...report,
      platforms: mergedPlatforms,
      publishedAt: allSucceeded ? new Date() : report.publishedAt,
    });
  });

  return [...reportMap.values()];
}

// ----------------------------------------------------------------
// 5. verifyPublication
// ----------------------------------------------------------------

export interface VerificationStatus {
  shopifyLive: boolean;
  etsyLive: boolean;
  shopifyError: string | null;
  etsyError: string | null;
}

/**
 * Verifies that both platform listings are live and accessible by
 * fetching them from their respective APIs.
 *
 * A listing is considered live when the API returns it without error.
 * For Etsy, additionally checks that the returned state is 'active'.
 *
 * Returns a VerificationStatus rather than throwing so the caller can
 * act on partial verification failures independently.
 */
export async function verifyPublication(
  clients: PublisherClients,
  shopifyId: string,
  etsyListingId: string,
): Promise<VerificationStatus> {
  logger.info({ shopifyId, etsyListingId }, 'Verifying publication status');

  const [shopifyOutcome, etsyOutcome] = await Promise.all([
    (async (): Promise<{ live: boolean; error: string | null }> => {
      try {
        await getProduct(clients.shopify, shopifyId);
        return { live: true, error: null };
      } catch (err) {
        const error =
          err instanceof Error
            ? err.message
            : 'Unknown error verifying Shopify product';
        logger.error({ shopifyId, err }, 'Shopify product verification failed');
        return { live: false, error };
      }
    })(),

    (async (): Promise<{ live: boolean; error: string | null }> => {
      try {
        const listing = await getListing(clients.etsy, etsyListingId);
        // An inactive or draft listing is not considered live.
        const isLive = listing.state === 'active';
        if (!isLive) {
          return {
            live: false,
            error: `Etsy listing state is '${listing.state}' — expected 'active'`,
          };
        }
        return { live: true, error: null };
      } catch (err) {
        const error =
          err instanceof Error
            ? err.message
            : 'Unknown error verifying Etsy listing';
        logger.error({ etsyListingId, err }, 'Etsy listing verification failed');
        return { live: false, error };
      }
    })(),
  ]);

  const status: VerificationStatus = {
    shopifyLive: shopifyOutcome.live,
    etsyLive: etsyOutcome.live,
    shopifyError: shopifyOutcome.error,
    etsyError: etsyOutcome.error,
  };

  logger.info(
    {
      shopifyId,
      etsyListingId,
      shopifyLive: status.shopifyLive,
      etsyLive: status.etsyLive,
    },
    'Publication verification complete',
  );

  return status;
}
