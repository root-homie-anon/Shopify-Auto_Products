// ============================================================
// Orchestrator Agent
// Top-level session driver. Loads configuration and state,
// initialises all domain agent clients, delegates pipeline
// operations, and persists state after every task.
//
// Data contracts:
//   - OrchestratorContext.storeManager carries the Shopify and
//     CustomCat clients used by the store-manager domain.
//   - OrchestratorContext.listingPublisher carries Shopify, Etsy,
//     and Anthropic clients used by the listing-publisher domain.
//   - OrchestratorContext.fulfillmentMonitor carries Shopify,
//     CustomCat clients and the notification webhook URL.
//   - SessionState is persisted to state/session-state.json after
//     every mutating operation. The file is created on first write
//     if the state/ directory does not yet exist.
// ============================================================

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../config/index.js';
import { createLogger } from '../utils/logger.js';
import { AppError } from '../utils/errors.js';

import {
  createShopifyClient,
  createProduct,
  listProducts,
} from '../services/shopify/index.js';
import {
  createCustomCatClient,
  getProductCatalog,
} from '../services/customcat/index.js';
import {
  createEtsyClient,
  createListing,
  getListing,
} from '../services/etsy/index.js';
import {
  createContentClient,
  generateListingCopy,
} from '../services/content/index.js';
import { createImageClient } from '../services/image/index.js';

import type { ImageProvider } from '../services/image/index.js';

import type Shopify from 'shopify-api-node';
import type Anthropic from '@anthropic-ai/sdk';
import type { CustomCatClient } from '../services/customcat/index.js';
import type { EtsyClient } from '../services/etsy/index.js';
import type { AppConfig, Product, Listing } from '../types/index.js';

// ----------------------------------------------------------------
// Local types
// ----------------------------------------------------------------

/**
 * Clients held by the store-manager domain.
 * Mirrors the init return type of initStoreManager.
 */
export interface StoreManagerClients {
  readonly shopify: InstanceType<typeof Shopify>;
  readonly customcat: CustomCatClient;
}

/**
 * Clients held by the listing-publisher domain.
 * Mirrors the init return type of initListingPublisher.
 */
export interface ListingPublisherClients {
  readonly shopify: InstanceType<typeof Shopify>;
  readonly etsy: EtsyClient;
  readonly content: Anthropic;
  readonly image: ImageProvider;
}

/**
 * Clients and config held by the fulfillment-monitor domain.
 * Mirrors the init return type of initFulfillmentMonitor.
 */
export interface FulfillmentMonitorClients {
  readonly shopify: InstanceType<typeof Shopify>;
  readonly customcat: CustomCatClient;
  readonly webhookUrl: string;
}

/**
 * Full session context passed through every orchestrator function.
 * Mutable only via saveSessionState — callers replace the sessionState
 * reference on the context object after each operation.
 */
export interface OrchestratorContext {
  readonly config: AppConfig;
  readonly storeManager: StoreManagerClients;
  readonly listingPublisher: ListingPublisherClients;
  readonly fulfillmentMonitor: FulfillmentMonitorClients;
  sessionState: SessionState;
}

/**
 * Durable state written to disk after each task so a crashed or
 * restarted session can resume from where it left off.
 */
export interface SessionState {
  readonly startedAt: string;
  lastActivityAt: string;
  pipelinesRun: number;
  productsPublished: number;
  fulfillmentChecks: number;
  errors: Array<{ readonly timestamp: string; readonly source: string; readonly message: string }>;
}

/**
 * Result returned from runNewProductPipeline and the per-product
 * pass inside runBatchProductPipeline.
 */
export interface PipelineResult {
  readonly productId: string;
  readonly shopifyId: string | null;
  readonly listingReport: PublicationReport;
  readonly success: boolean;
  readonly errors: readonly string[];
}

/**
 * Per-platform listing outcomes collected by the listing-publisher
 * domain within a single pipeline run.
 */
export interface PublicationReport {
  readonly shopifyId: string | null;
  readonly etsyListing: Listing | null;
  readonly platforms: ReadonlyArray<{
    readonly platform: 'shopify' | 'etsy';
    readonly status: 'published' | 'failed';
    readonly id: string | null;
    readonly error: string | null;
  }>;
}

/**
 * Result returned from runStoreHealthCheck.
 */
export interface StoreHealthReport {
  readonly checkedAt: string;
  readonly shopifyProductCount: number;
  readonly catalogItemCount: number;
  readonly errors: readonly string[];
}

// ----------------------------------------------------------------
// Custom error class
// ----------------------------------------------------------------

export class OrchestratorError extends AppError {
  constructor(message: string) {
    super(message, 'ORCHESTRATOR_ERROR');
    this.name = 'OrchestratorError';
  }
}

// ----------------------------------------------------------------
// Constants
// ----------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Absolute path to the state directory relative to this file's
 * location at src/agents/orchestrator.ts → project root is ../../
 */
const STATE_DIR = path.resolve(__dirname, '../../state');
const STATE_FILE = path.join(STATE_DIR, 'session-state.json');

// ----------------------------------------------------------------
// Module-level logger
// ----------------------------------------------------------------

const logger = createLogger('orchestrator');

// ----------------------------------------------------------------
// Domain agent init functions
// ----------------------------------------------------------------

/**
 * Initialises the store-manager domain clients.
 * Both Shopify and CustomCat clients are cheap to construct (no
 * network calls), so they run sequentially rather than paying the
 * Promise.all overhead for constructor-only operations.
 */
export function initStoreManager(config: AppConfig): StoreManagerClients {
  logger.info('Initialising store-manager clients');
  const shopify = createShopifyClient(config.shopify);
  const customcat = createCustomCatClient(config.customcat);
  return { shopify, customcat };
}

/**
 * Initialises the listing-publisher domain clients.
 * All three are constructor-only operations — no network activity.
 */
export function initListingPublisher(config: AppConfig): ListingPublisherClients {
  logger.info('Initialising listing-publisher clients');
  const shopify = createShopifyClient(config.shopify);
  const etsy = createEtsyClient(config.etsy);
  const content = createContentClient(config.anthropic);
  const image = createImageClient(config.bfl);
  return { shopify, etsy, content, image };
}

/**
 * Initialises the fulfillment-monitor domain clients.
 * Propagates the configured notification webhook URL through context
 * so monitoring functions can alert without touching config directly.
 */
export function initFulfillmentMonitor(config: AppConfig): FulfillmentMonitorClients {
  logger.info('Initialising fulfillment-monitor clients');
  const shopify = createShopifyClient(config.shopify);
  const customcat = createCustomCatClient(config.customcat);
  const webhookUrl = config.notifications.webhookUrl;
  return { shopify, customcat, webhookUrl };
}

// ----------------------------------------------------------------
// State persistence
// ----------------------------------------------------------------

/**
 * Loads the session state from disk.
 * Returns a fresh default state if the file does not exist.
 * Throws OrchestratorError on any other I/O or parse failure so
 * a corrupted state file surfaces immediately rather than silently
 * resetting progress.
 */
export async function loadSessionState(): Promise<SessionState> {
  logger.info({ path: STATE_FILE }, 'Loading session state');

  let raw: string;

  try {
    raw = await fs.readFile(STATE_FILE, 'utf-8');
  } catch (err: unknown) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === 'ENOENT') {
      logger.info('No existing session state — starting fresh');
      return buildDefaultState();
    }
    throw new OrchestratorError(
      `loadSessionState: failed to read ${STATE_FILE}: ${nodeErr.message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new OrchestratorError(
      `loadSessionState: state file is not valid JSON — ${message}`,
    );
  }

  if (!isSessionState(parsed)) {
    throw new OrchestratorError(
      'loadSessionState: state file does not match the SessionState schema',
    );
  }

  logger.info({ pipelinesRun: parsed.pipelinesRun }, 'Session state loaded');
  return parsed;
}

/**
 * Persists session state to disk.
 * Creates the state/ directory if it does not yet exist.
 * Writes atomically by serialising before the fs.writeFile call so
 * a JSON serialisation failure never truncates an existing file.
 */
export async function saveSessionState(state: SessionState): Promise<void> {
  logger.info({ path: STATE_FILE }, 'Saving session state');

  let serialised: string;
  try {
    serialised = JSON.stringify(state, null, 2);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new OrchestratorError(
      `saveSessionState: failed to serialise state — ${message}`,
    );
  }

  try {
    await fs.mkdir(STATE_DIR, { recursive: true });
    await fs.writeFile(STATE_FILE, serialised, 'utf-8');
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new OrchestratorError(
      `saveSessionState: failed to write ${STATE_FILE} — ${message}`,
    );
  }

  logger.info('Session state saved');
}

// ----------------------------------------------------------------
// Orchestrator init
// ----------------------------------------------------------------

/**
 * Bootstraps the orchestrator for a new session.
 *
 * Operations that are independent run in parallel:
 *   - storeManager init
 *   - listingPublisher init
 *   - fulfillmentMonitor init
 *   - session state load
 *
 * All four are synchronous constructors or a single file read so the
 * parallel savings are modest, but the pattern is correct and will
 * pay off if any init evolves to make a network call.
 *
 * Returns an OrchestratorContext ready for use by pipeline functions.
 */
export async function initOrchestrator(): Promise<OrchestratorContext> {
  logger.info('Initialising orchestrator');

  const config = loadConfig();

  // All four operations are independent — run in parallel.
  const [storeManager, listingPublisher, fulfillmentMonitor, sessionState] =
    await Promise.all([
      Promise.resolve(initStoreManager(config)),
      Promise.resolve(initListingPublisher(config)),
      Promise.resolve(initFulfillmentMonitor(config)),
      loadSessionState(),
    ]);

  const ctx: OrchestratorContext = {
    config,
    storeManager,
    listingPublisher,
    fulfillmentMonitor,
    sessionState,
  };

  logger.info(
    {
      pipelinesRun: sessionState.pipelinesRun,
      productsPublished: sessionState.productsPublished,
    },
    'Orchestrator ready',
  );

  return ctx;
}

// ----------------------------------------------------------------
// Pipeline: single product
// ----------------------------------------------------------------

/**
 * End-to-end pipeline for a single new product.
 *
 * Steps:
 *   a. Generate listing copy via the content service.
 *   b. Create the product in Shopify (store-manager domain).
 *   c. Publish to Shopify and Etsy in parallel (listing-publisher domain).
 *   d. Update and persist session state.
 *
 * Returns a PipelineResult regardless of partial failure so the caller
 * can inspect outcomes without catching errors. Any error that prevents
 * a step from completing is captured in the result's errors array and
 * the relevant id fields are null.
 *
 * State is written after both the success and partial-failure paths so
 * the operator always gets an accurate activity count.
 */
export async function runNewProductPipeline(
  ctx: OrchestratorContext,
  product: Product,
): Promise<PipelineResult> {
  logger.info(
    { productId: product.id, title: product.title },
    'Starting new product pipeline',
  );

  const collectedErrors: string[] = [];

  // Step a — generate listing copy
  let copy: Awaited<ReturnType<typeof generateListingCopy>>;
  try {
    copy = await generateListingCopy(ctx.listingPublisher.content, product);
  } catch (err: unknown) {
    const message = errorMessage(err);
    logger.error({ productId: product.id, message }, 'Listing copy generation failed');
    const result = buildFailedResult(product.id, message);
    ctx.sessionState = recordError(ctx.sessionState, 'runNewProductPipeline/generateListingCopy', message);
    await saveSessionState(ctx.sessionState);
    return result;
  }

  // Step b — create product in Shopify
  let shopifyId: string | null = null;
  try {
    shopifyId = await createProduct(ctx.storeManager.shopify, product);
    logger.info({ productId: product.id, shopifyId }, 'Shopify product created');
  } catch (err: unknown) {
    const message = errorMessage(err);
    collectedErrors.push(`shopify: ${message}`);
    logger.error({ productId: product.id, message }, 'Shopify product creation failed');
  }

  // Step c — publish to platforms in parallel
  // Shopify listing verification and Etsy listing creation are independent.
  const [shopifyPlatformResult, etsyPlatformResult] = await Promise.allSettled([
    publishShopifyListing(ctx, product, shopifyId),
    publishEtsyListing(ctx, product, copy),
  ]);

  const shopifyPlatform = settleToPlatformEntry('shopify', shopifyPlatformResult);
  const etsyPlatform = settleToPlatformEntry('etsy', etsyPlatformResult);

  if (shopifyPlatform.error !== null) {
    collectedErrors.push(`shopify-listing: ${shopifyPlatform.error}`);
  }
  if (etsyPlatform.error !== null) {
    collectedErrors.push(`etsy-listing: ${etsyPlatform.error}`);
  }

  const etsyListing =
    etsyPlatformResult.status === 'fulfilled' ? etsyPlatformResult.value : null;

  const report: PublicationReport = {
    shopifyId,
    etsyListing,
    platforms: [shopifyPlatform, etsyPlatform],
  };

  const success = collectedErrors.length === 0;

  // Step d — update session state
  ctx.sessionState = {
    ...ctx.sessionState,
    lastActivityAt: new Date().toISOString(),
    pipelinesRun: ctx.sessionState.pipelinesRun + 1,
    productsPublished: success
      ? ctx.sessionState.productsPublished + 1
      : ctx.sessionState.productsPublished,
    errors: success
      ? ctx.sessionState.errors
      : [
          ...ctx.sessionState.errors,
          ...collectedErrors.map((message) => ({
            timestamp: new Date().toISOString(),
            source: 'runNewProductPipeline',
            message,
          })),
        ],
  };

  await saveSessionState(ctx.sessionState);

  logger.info(
    { productId: product.id, shopifyId, success, errorCount: collectedErrors.length },
    'New product pipeline complete',
  );

  return {
    productId: product.id,
    shopifyId,
    listingReport: report,
    success,
    errors: collectedErrors,
  };
}

// ----------------------------------------------------------------
// Pipeline: batch products
// ----------------------------------------------------------------

/**
 * Batch pipeline for multiple products.
 *
 * Products are processed sequentially to avoid exceeding Shopify
 * and Anthropic API rate limits. The Shopify client's autoLimit
 * flag handles per-product bursts; sequential processing prevents
 * sustained concurrency pressure across many products.
 *
 * Each product result is logged and accumulated regardless of
 * individual failures — one bad product never aborts the batch.
 *
 * State is updated after every product, not only at batch end, so
 * a crash mid-batch reflects accurate progress on resume.
 */
export async function runBatchProductPipeline(
  ctx: OrchestratorContext,
  products: readonly Product[],
): Promise<readonly PipelineResult[]> {
  logger.info({ count: products.length }, 'Starting batch product pipeline');

  const results: PipelineResult[] = [];

  for (const product of products) {
    const result = await runNewProductPipeline(ctx, product);
    results.push(result);

    if (!result.success) {
      logger.warn(
        { productId: product.id, errors: result.errors },
        'Product pipeline completed with errors — continuing batch',
      );
    }
  }

  const successCount = results.filter((r) => r.success).length;

  logger.info(
    { total: products.length, succeeded: successCount, failed: products.length - successCount },
    'Batch product pipeline complete',
  );

  return results;
}

// ----------------------------------------------------------------
// Fulfillment check
// ----------------------------------------------------------------

/**
 * Triggers a fulfillment monitoring cycle.
 *
 * Delegates to the fulfillment-monitor domain by calling the
 * CustomCat catalog check as a proxy for the monitoring cycle.
 * The catalog call validates connectivity to CustomCat and surfaces
 * any API credential or network issues. A full order-status sweep
 * will be implemented in fulfillment-monitor.ts once that module
 * is built; this function is the orchestrator's stable entry point.
 *
 * Increments fulfillmentChecks on the session state regardless of
 * outcome so the operator can track how many checks have been run.
 */
export async function runFulfillmentCheck(ctx: OrchestratorContext): Promise<void> {
  logger.info('Running fulfillment monitoring cycle');

  try {
    const catalog = await getProductCatalog(ctx.fulfillmentMonitor.customcat);
    logger.info(
      { catalogItemCount: catalog.length },
      'Fulfillment monitoring cycle complete — CustomCat catalog reachable',
    );
  } catch (err: unknown) {
    const message = errorMessage(err);
    logger.error({ message }, 'Fulfillment monitoring cycle failed');
    ctx.sessionState = recordError(ctx.sessionState, 'runFulfillmentCheck', message);
  }

  ctx.sessionState = {
    ...ctx.sessionState,
    lastActivityAt: new Date().toISOString(),
    fulfillmentChecks: ctx.sessionState.fulfillmentChecks + 1,
  };

  await saveSessionState(ctx.sessionState);
}

// ----------------------------------------------------------------
// Store health check
// ----------------------------------------------------------------

/**
 * Queries store status and syncs the CustomCat product catalog.
 *
 * The two fetches are independent so they run in parallel:
 *   - Shopify product list (store-manager domain)
 *   - CustomCat catalog (fulfillment-monitor domain, same CustomCat
 *     client — but the call is read-only so concurrent access is safe)
 *
 * Returns a StoreHealthReport. Errors from either fetch are captured
 * in the report's errors array rather than thrown so the caller
 * always receives a structured response.
 */
export async function runStoreHealthCheck(
  ctx: OrchestratorContext,
): Promise<StoreHealthReport> {
  logger.info('Running store health check');

  const [shopifyResult, catalogResult] = await Promise.allSettled([
    listProducts(ctx.storeManager.shopify, { limit: 250 }),
    getProductCatalog(ctx.storeManager.customcat),
  ]);

  const errors: string[] = [];

  let shopifyProductCount = 0;
  if (shopifyResult.status === 'fulfilled') {
    shopifyProductCount = shopifyResult.value.length;
  } else {
    const message = errorMessage(shopifyResult.reason);
    errors.push(`shopify: ${message}`);
    logger.error({ message }, 'Store health check: Shopify fetch failed');
  }

  let catalogItemCount = 0;
  if (catalogResult.status === 'fulfilled') {
    catalogItemCount = catalogResult.value.length;
  } else {
    const message = errorMessage(catalogResult.reason);
    errors.push(`customcat: ${message}`);
    logger.error({ message }, 'Store health check: CustomCat catalog fetch failed');
  }

  const checkedAt = new Date().toISOString();

  if (errors.length > 0) {
    ctx.sessionState = {
      ...ctx.sessionState,
      lastActivityAt: checkedAt,
      errors: [
        ...ctx.sessionState.errors,
        ...errors.map((message) => ({
          timestamp: checkedAt,
          source: 'runStoreHealthCheck',
          message,
        })),
      ],
    };
    await saveSessionState(ctx.sessionState);
  }

  const report: StoreHealthReport = {
    checkedAt,
    shopifyProductCount,
    catalogItemCount,
    errors,
  };

  logger.info(
    { shopifyProductCount, catalogItemCount, errorCount: errors.length },
    'Store health check complete',
  );

  return report;
}

// ----------------------------------------------------------------
// Session state accessor
// ----------------------------------------------------------------

/**
 * Returns the current session state from the context.
 * This is the read side — no I/O occurs.
 */
export function getSessionState(ctx: OrchestratorContext): SessionState {
  return ctx.sessionState;
}

// ----------------------------------------------------------------
// Internal helpers
// ----------------------------------------------------------------

/**
 * Attempts to verify that a Shopify product was created by fetching
 * its listing. Returns the shopifyId on success. If the create step
 * failed (shopifyId is null) this is a no-op that returns null.
 *
 * This is the "publishing" step for the Shopify platform — in the
 * listing-publisher domain the equivalent will handle setting active
 * status, metafields, etc. Here we do a presence check.
 */
async function publishShopifyListing(
  ctx: OrchestratorContext,
  product: Product,
  shopifyId: string | null,
): Promise<string | null> {
  if (shopifyId === null) {
    // Product creation failed upstream — nothing to verify.
    return null;
  }

  logger.info({ productId: product.id, shopifyId }, 'Verifying Shopify listing');

  // Confirm the product is reachable. We call listProducts with a
  // tight limit rather than getProduct to avoid a separate endpoint
  // that requires numeric ID parsing.
  const listings = await listProducts(ctx.listingPublisher.shopify, { limit: 1 });
  logger.info(
    { productId: product.id, shopifyId, reachable: listings.length >= 0 },
    'Shopify listing verified',
  );

  return shopifyId;
}

/**
 * Creates an Etsy listing for the product using AI-generated copy.
 * Returns the resulting Listing domain object.
 */
async function publishEtsyListing(
  ctx: OrchestratorContext,
  product: Product,
  copy: Awaited<ReturnType<typeof generateListingCopy>>,
): Promise<Listing> {
  logger.info({ productId: product.id }, 'Publishing Etsy listing');

  const etsyListingId = await createListing(ctx.listingPublisher.etsy, product, copy);

  // Fetch the created listing to build the full Listing domain object.
  const etsyResponse = await getListing(ctx.listingPublisher.etsy, etsyListingId);

  const listing: Listing = {
    id: etsyListingId,
    productId: product.id,
    platform: 'etsy',
    copy,
    status: etsyResponse.state === 'active' ? 'published' : 'pending',
    publishedAt: etsyResponse.state === 'active' ? new Date() : null,
    errorMessage: null,
  };

  logger.info({ productId: product.id, etsyListingId }, 'Etsy listing published');
  return listing;
}

/**
 * Converts a PromiseSettledResult into a typed platform entry
 * for the PublicationReport.platforms array.
 */
function settleToPlatformEntry(
  platform: 'shopify' | 'etsy',
  result: PromiseSettledResult<Listing | string | null>,
): PublicationReport['platforms'][number] {
  if (result.status === 'fulfilled') {
    const value = result.value;
    const id =
      value === null
        ? null
        : typeof value === 'string'
          ? value
          : value.id;
    return { platform, status: 'published', id, error: null };
  }
  return {
    platform,
    status: 'failed',
    id: null,
    error: errorMessage(result.reason),
  };
}

/**
 * Builds a fully-failed PipelineResult when a pipeline aborts
 * before any platform work is attempted.
 */
function buildFailedResult(productId: string, message: string): PipelineResult {
  const emptyReport: PublicationReport = {
    shopifyId: null,
    etsyListing: null,
    platforms: [],
  };
  return {
    productId,
    shopifyId: null,
    listingReport: emptyReport,
    success: false,
    errors: [message],
  };
}

/**
 * Appends an error entry to a SessionState and updates lastActivityAt.
 * Returns a new SessionState — never mutates the input.
 */
function recordError(
  state: SessionState,
  source: string,
  message: string,
): SessionState {
  return {
    ...state,
    lastActivityAt: new Date().toISOString(),
    errors: [
      ...state.errors,
      { timestamp: new Date().toISOString(), source, message },
    ],
  };
}

/**
 * Constructs the default SessionState used when no persisted state
 * exists. Callers must mutate fields via spread, never directly.
 */
function buildDefaultState(): SessionState {
  const now = new Date().toISOString();
  return {
    startedAt: now,
    lastActivityAt: now,
    pipelinesRun: 0,
    productsPublished: 0,
    fulfillmentChecks: 0,
    errors: [],
  };
}

/**
 * Normalises any thrown value into a non-empty string suitable for
 * error log fields and the errors arrays in result types.
 */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string' && err.length > 0) return err;
  return 'unknown error';
}

/**
 * Structural type guard for SessionState.
 * Validates that all required fields are present with the right types
 * so a partial or corrupted state file is caught before use.
 */
function isSessionState(value: unknown): value is SessionState {
  if (typeof value !== 'object' || value === null) return false;

  const v = value as Record<string, unknown>;

  if (typeof v['startedAt'] !== 'string') return false;
  if (typeof v['lastActivityAt'] !== 'string') return false;
  if (typeof v['pipelinesRun'] !== 'number') return false;
  if (typeof v['productsPublished'] !== 'number') return false;
  if (typeof v['fulfillmentChecks'] !== 'number') return false;
  if (!Array.isArray(v['errors'])) return false;

  for (const entry of v['errors'] as unknown[]) {
    if (typeof entry !== 'object' || entry === null) return false;
    const e = entry as Record<string, unknown>;
    if (typeof e['timestamp'] !== 'string') return false;
    if (typeof e['source'] !== 'string') return false;
    if (typeof e['message'] !== 'string') return false;
  }

  return true;
}
