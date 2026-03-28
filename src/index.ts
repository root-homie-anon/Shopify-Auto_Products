// ============================================================
// Banyakob CLI Entry Point
//
// Usage:
//   bun run src/index.ts publish <product-json-path>
//   bun run src/index.ts publish-batch <products-json-path>
//   bun run src/index.ts monitor
//   bun run src/index.ts health
//   bun run src/index.ts status
//   bun run src/index.ts help
// ============================================================

import fs from 'node:fs/promises';
import path from 'node:path';

import { createLogger } from './utils/logger.js';
import {
  initOrchestrator,
  runNewProductPipeline,
  runBatchProductPipeline,
  runFulfillmentCheck,
  runStoreHealthCheck,
  getSessionState,
} from './agents/orchestrator.js';

import type { Product } from './types/index.js';

// ----------------------------------------------------------------
// Custom error class
// ----------------------------------------------------------------

class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliError';
  }
}

// ----------------------------------------------------------------
// Module-level logger
// ----------------------------------------------------------------

const logger = createLogger('banyakob-cli');

// ----------------------------------------------------------------
// Usage
// ----------------------------------------------------------------

function printUsage(): void {
  process.stdout.write(`
Banyakob Automation Platform

Usage:
  bun run src/index.ts <command> [args]

Commands:
  publish <product-json-path>        Run the new product pipeline for a single product
  publish-batch <products-json-path> Run the batch pipeline for an array of products
  monitor                            Run a fulfillment monitoring cycle
  health                             Run a store health check
  status                             Print the current session state
  help                               Show this usage message
`.trim() + '\n');
}

// ----------------------------------------------------------------
// JSON file loader
// ----------------------------------------------------------------

async function readJsonFile(filePath: string): Promise<unknown> {
  const resolved = path.resolve(filePath);

  try {
    await fs.access(resolved);
  } catch {
    throw new CliError(`File not found: ${resolved}`);
  }

  let raw: string;
  try {
    raw = await fs.readFile(resolved, 'utf-8');
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CliError(`Failed to read file ${resolved}: ${message}`);
  }

  try {
    return JSON.parse(raw);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CliError(`File is not valid JSON (${resolved}): ${message}`);
  }
}

// ----------------------------------------------------------------
// Command handlers
// ----------------------------------------------------------------

async function handlePublish(filePath: string | undefined): Promise<void> {
  if (filePath === undefined || filePath.trim() === '') {
    throw new CliError('publish requires a product JSON file path as the second argument');
  }

  const raw = await readJsonFile(filePath);
  const product = raw as Product;

  const ctx = await initOrchestrator();
  const result = await runNewProductPipeline(ctx, product);

  if (result.success) {
    logger.info(
      { productId: result.productId, shopifyId: result.shopifyId },
      'Product published successfully',
    );
  } else {
    logger.warn(
      { productId: result.productId, errors: result.errors },
      'Product pipeline completed with errors',
    );
  }
}

async function handlePublishBatch(filePath: string | undefined): Promise<void> {
  if (filePath === undefined || filePath.trim() === '') {
    throw new CliError('publish-batch requires a products JSON file path as the second argument');
  }

  const raw = await readJsonFile(filePath);

  if (!Array.isArray(raw)) {
    throw new CliError('publish-batch expects a JSON array of product objects');
  }

  const products = raw as Product[];

  const ctx = await initOrchestrator();
  const results = await runBatchProductPipeline(ctx, products);

  const succeeded = results.filter((r) => r.success).length;
  const failed = results.length - succeeded;

  logger.info(
    { total: results.length, succeeded, failed },
    'Batch pipeline complete',
  );

  if (failed > 0) {
    logger.warn(
      {
        failures: results
          .filter((r) => !r.success)
          .map((r) => ({ productId: r.productId, errors: r.errors })),
      },
      'Some products failed during batch pipeline',
    );
  }
}

async function handleMonitor(): Promise<void> {
  const ctx = await initOrchestrator();
  await runFulfillmentCheck(ctx);
  logger.info('Fulfillment monitoring cycle complete');
}

async function handleHealth(): Promise<void> {
  const ctx = await initOrchestrator();
  const report = await runStoreHealthCheck(ctx);

  logger.info(
    {
      checkedAt: report.checkedAt,
      shopifyProductCount: report.shopifyProductCount,
      catalogItemCount: report.catalogItemCount,
      errorCount: report.errors.length,
    },
    'Store health check complete',
  );

  if (report.errors.length > 0) {
    logger.warn({ errors: report.errors }, 'Health check reported errors');
  }
}

async function handleStatus(): Promise<void> {
  const ctx = await initOrchestrator();
  const state = getSessionState(ctx);

  logger.info(
    {
      startedAt: state.startedAt,
      lastActivityAt: state.lastActivityAt,
      pipelinesRun: state.pipelinesRun,
      productsPublished: state.productsPublished,
      fulfillmentChecks: state.fulfillmentChecks,
      errorCount: state.errors.length,
    },
    'Session state',
  );
}

// ----------------------------------------------------------------
// Main
// ----------------------------------------------------------------

async function main(): Promise<void> {
  const command = process.argv[2];
  const arg = process.argv[3];

  switch (command) {
    case 'publish':
      await handlePublish(arg);
      break;

    case 'publish-batch':
      await handlePublishBatch(arg);
      break;

    case 'monitor':
      await handleMonitor();
      break;

    case 'health':
      await handleHealth();
      break;

    case 'status':
      await handleStatus();
      break;

    case 'help':
    case undefined:
      printUsage();
      break;

    default:
      logger.error({ command }, 'Unknown command');
      printUsage();
      process.exit(1);
  }
}

main().then(() => {
  process.exit(0);
}).catch((err: unknown) => {
  if (err instanceof CliError) {
    logger.error({ message: err.message }, 'CLI error');
  } else if (err instanceof Error) {
    logger.error({ message: err.message, stack: err.stack }, 'Unexpected error');
  } else {
    logger.error({ err }, 'Unexpected error');
  }
  process.exit(1);
});
