// ============================================================
// Listing Publisher Agent — Unit Tests
// Focus: PublicationReport construction, partial platform failure
// isolation (one platform fails, other succeeds — both captured
// in the report), and the retryFailedListings logic.
// All service dependencies are mocked.
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Product, ListingCopy, AppConfig } from '../../types/index.js';

// ----------------------------------------------------------------
// Hoist all mock functions before vi.mock() factory execution
// ----------------------------------------------------------------

const {
  mockCreateShopifyClient,
  mockCreateProduct,
  mockGetProduct,
  mockCreateEtsyClient,
  mockSyncFromShopify,
  mockGetListing,
  mockCreateContentClient,
  mockGenerateListingCopy,
  mockGenerateBatchListingCopy,
} = vi.hoisted(() => {
  return {
    mockCreateShopifyClient: vi.fn().mockReturnValue({ _tag: 'shopify-client' }),
    mockCreateProduct: vi.fn(),
    mockGetProduct: vi.fn(),
    mockCreateEtsyClient: vi.fn().mockReturnValue({ _tag: 'etsy-client' }),
    mockSyncFromShopify: vi.fn(),
    mockGetListing: vi.fn(),
    mockCreateContentClient: vi.fn().mockReturnValue({ _tag: 'content-client' }),
    mockGenerateListingCopy: vi.fn(),
    mockGenerateBatchListingCopy: vi.fn(),
  };
});

vi.mock('../../services/shopify/index.js', () => ({
  createShopifyClient: mockCreateShopifyClient,
  createProduct: mockCreateProduct,
  getProduct: mockGetProduct,
}));

vi.mock('../../services/etsy/index.js', () => ({
  createEtsyClient: mockCreateEtsyClient,
  syncFromShopify: mockSyncFromShopify,
  getListing: mockGetListing,
}));

vi.mock('../../services/content/index.js', () => ({
  createContentClient: mockCreateContentClient,
  generateListingCopy: mockGenerateListingCopy,
  generateBatchListingCopy: mockGenerateBatchListingCopy,
}));

// Import agent after mocks
import {
  initListingPublisher,
  publishProduct,
  publishBatch,
  retryFailedListings,
} from '../../agents/listing-publisher.js';
import type { PublicationReport, PublisherClients } from '../../agents/listing-publisher.js';
import { ListingError } from '../../utils/errors.js';

// ----------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------

const appConfig: AppConfig = {
  shopify: { shopName: 'test', apiKey: 'k', apiSecret: 's', accessToken: 't' },
  etsy: { apiKey: 'k', apiSecret: 's', accessToken: 't', shopId: 'shop-1' },
  customcat: { apiKey: 'k', apiUrl: 'https://cc.test' },
  anthropic: { apiKey: 'sk-ant' },
  openai: { apiKey: 'sk-oai' },
  meta: { appId: 'a', appSecret: 'b', accessToken: 'c', adAccountId: 'd', pixelId: 'e' },
  notifications: { webhookUrl: 'https://notify.test/hook' },
  app: { nodeEnv: 'development', logLevel: 'error' },
};

function makeProduct(overrides: Partial<Product> = {}): Product {
  return {
    id: 'prod-001',
    title: 'Archangel Michael Tee',
    description: '<p>Sacred streetwear.</p>',
    design: {
      id: 'design-001',
      name: 'Archangel Michael',
      frontImageUrl: 'https://cdn.test/front.jpg',
      backImageUrl: null,
      createdAt: new Date('2025-01-01'),
      approvedAt: new Date('2025-01-02'),
    },
    variants: [
      {
        size: 'M',
        color: 'Black',
        sku: 'BC-M-BLK',
        price: 29.99,
        compareAtPrice: null,
        inventoryQuantity: 50,
      },
    ],
    tags: ['christian apparel'],
    productType: 'T-Shirt',
    vendor: 'Banyakob',
    status: 'active',
    shopifyId: null,
    etsyListingId: null,
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    ...overrides,
  };
}

function makeCopy(overrides: Partial<ListingCopy> = {}): ListingCopy {
  return {
    title: 'Archangel Michael Icon — Unisex T-Shirt | Banyakob',
    description: '<p>Sacred art on premium cotton.</p>',
    tags: ['christian apparel', 'byzantine art'],
    seoTitle: 'Archangel Michael Christian T-Shirt | Banyakob',
    seoDescription: 'Faith apparel by Banyakob.',
    ...overrides,
  };
}

function makeEtsyListingSuccess(listingId: string = 'etsy-listing-001'): object {
  return {
    id: listingId,
    productId: 'prod-001',
    platform: 'etsy',
    copy: makeCopy(),
    status: 'published',
    publishedAt: new Date(),
    errorMessage: null,
  };
}

function makeEtsyListingFailure(): object {
  return {
    id: '',
    productId: 'prod-001',
    platform: 'etsy',
    copy: makeCopy(),
    status: 'failed',
    publishedAt: null,
    errorMessage: 'Etsy API rejected listing',
  };
}

function makeClients(): PublisherClients {
  return initListingPublisher(appConfig);
}

// ----------------------------------------------------------------
// 1. initListingPublisher
// ----------------------------------------------------------------

describe('initListingPublisher', () => {
  beforeEach(() => {
    mockCreateShopifyClient.mockClear();
    mockCreateEtsyClient.mockClear();
    mockCreateContentClient.mockClear();
  });

  it('initialises all three service clients', () => {
    initListingPublisher(appConfig);

    expect(mockCreateShopifyClient).toHaveBeenCalledOnce();
    expect(mockCreateEtsyClient).toHaveBeenCalledOnce();
    expect(mockCreateContentClient).toHaveBeenCalledOnce();
  });

  it('returns an object with shopify, etsy, and content clients', () => {
    const clients = initListingPublisher(appConfig);

    expect(clients.shopify).toBeDefined();
    expect(clients.etsy).toBeDefined();
    expect(clients.content).toBeDefined();
  });
});

// ----------------------------------------------------------------
// 2. publishProduct — PublicationReport construction
// ----------------------------------------------------------------

describe('publishProduct — report construction', () => {
  let clients: PublisherClients;

  beforeEach(() => {
    clients = makeClients();
    mockGenerateListingCopy.mockReset();
    mockCreateProduct.mockReset();
    mockSyncFromShopify.mockReset();
  });

  it('report contains the product ID', async () => {
    mockGenerateListingCopy.mockResolvedValueOnce(makeCopy());
    mockCreateProduct.mockResolvedValueOnce('shopify-id-001');
    mockSyncFromShopify.mockResolvedValueOnce(makeEtsyListingSuccess());

    const report = await publishProduct(clients, makeProduct({ id: 'test-prod-id' }));

    expect(report.productId).toBe('test-prod-id');
  });

  it('report contains the generated copy', async () => {
    const copy = makeCopy({ title: 'Custom Title | Banyakob' });
    mockGenerateListingCopy.mockResolvedValueOnce(copy);
    mockCreateProduct.mockResolvedValueOnce('shopify-id-001');
    mockSyncFromShopify.mockResolvedValueOnce(makeEtsyListingSuccess());

    const report = await publishProduct(clients, makeProduct());

    expect(report.copy.title).toBe('Custom Title | Banyakob');
  });

  it('report.platforms has exactly two entries (shopify + etsy)', async () => {
    mockGenerateListingCopy.mockResolvedValueOnce(makeCopy());
    mockCreateProduct.mockResolvedValueOnce('shopify-id-001');
    mockSyncFromShopify.mockResolvedValueOnce(makeEtsyListingSuccess());

    const report = await publishProduct(clients, makeProduct());

    expect(report.platforms).toHaveLength(2);
    const platforms = report.platforms.map((p) => p.platform);
    expect(platforms).toContain('shopify');
    expect(platforms).toContain('etsy');
  });

  it('sets publishedAt to a Date when both platforms succeed', async () => {
    mockGenerateListingCopy.mockResolvedValueOnce(makeCopy());
    mockCreateProduct.mockResolvedValueOnce('shopify-id-001');
    mockSyncFromShopify.mockResolvedValueOnce(makeEtsyListingSuccess());

    const report = await publishProduct(clients, makeProduct());

    expect(report.publishedAt).toBeInstanceOf(Date);
  });

  it('sets publishedAt to null when at least one platform fails', async () => {
    mockGenerateListingCopy.mockResolvedValueOnce(makeCopy());
    mockCreateProduct.mockResolvedValueOnce('shopify-id-001');
    // Etsy sync returns a failed Listing (status 'failed')
    mockSyncFromShopify.mockResolvedValueOnce(makeEtsyListingFailure());

    const report = await publishProduct(clients, makeProduct());

    expect(report.publishedAt).toBeNull();
  });
});

// ----------------------------------------------------------------
// 3. publishProduct — partial platform failure isolation
// ----------------------------------------------------------------

describe('publishProduct — one platform fails, other succeeds', () => {
  let clients: PublisherClients;

  beforeEach(() => {
    clients = makeClients();
    mockGenerateListingCopy.mockReset();
    mockCreateProduct.mockReset();
    mockSyncFromShopify.mockReset();
  });

  it('Shopify fails — Etsy result is still captured in the report', async () => {
    mockGenerateListingCopy.mockResolvedValueOnce(makeCopy());
    // Shopify createProduct throws on every attempt (exhaust retries)
    mockCreateProduct.mockRejectedValue(new Error('Shopify API down'));
    mockSyncFromShopify.mockResolvedValueOnce(makeEtsyListingSuccess('etsy-ok-456'));

    const report = await publishProduct(clients, makeProduct());

    const shopifyResult = report.platforms.find((p) => p.platform === 'shopify');
    const etsyResult = report.platforms.find((p) => p.platform === 'etsy');

    expect(shopifyResult?.status).toBe('failed');
    expect(etsyResult?.status).toBe('published');
    expect(etsyResult?.platformId).toBe('etsy-ok-456');
  }, 10000); // retry backoff takes ~1.5s total

  it('Etsy fails — Shopify result is still captured in the report', async () => {
    mockGenerateListingCopy.mockResolvedValueOnce(makeCopy());
    mockCreateProduct.mockResolvedValueOnce('shopify-id-ok');
    // Etsy sync returns failed listing every time (triggers retries, all fail)
    mockSyncFromShopify.mockResolvedValue(makeEtsyListingFailure());

    const report = await publishProduct(clients, makeProduct());

    const shopifyResult = report.platforms.find((p) => p.platform === 'shopify');
    const etsyResult = report.platforms.find((p) => p.platform === 'etsy');

    expect(shopifyResult?.status).toBe('published');
    expect(shopifyResult?.platformId).toBe('shopify-id-ok');
    expect(etsyResult?.status).toBe('failed');
  }, 10000);

  it('Shopify fail result carries a non-null errorMessage', async () => {
    mockGenerateListingCopy.mockResolvedValueOnce(makeCopy());
    mockCreateProduct.mockRejectedValue(new Error('Shopify rate limit'));
    mockSyncFromShopify.mockResolvedValueOnce(makeEtsyListingSuccess());

    const report = await publishProduct(clients, makeProduct());

    const shopifyResult = report.platforms.find((p) => p.platform === 'shopify');

    expect(shopifyResult?.errorMessage).not.toBeNull();
    expect(shopifyResult?.errorMessage).toContain('Shopify rate limit');
  }, 10000);

  it('Etsy fail result carries a non-null errorMessage', async () => {
    mockGenerateListingCopy.mockResolvedValueOnce(makeCopy());
    mockCreateProduct.mockResolvedValueOnce('shopify-id-ok');
    mockSyncFromShopify.mockResolvedValue({
      ...makeEtsyListingFailure(),
      errorMessage: 'Etsy rejected the listing',
    });

    const report = await publishProduct(clients, makeProduct());

    const etsyResult = report.platforms.find((p) => p.platform === 'etsy');

    expect(etsyResult?.errorMessage).not.toBeNull();
  }, 10000);
});

// ----------------------------------------------------------------
// 4. publishProduct — copy generation failure aborts both platforms
// ----------------------------------------------------------------

describe('publishProduct — copy generation failure', () => {
  let clients: PublisherClients;

  beforeEach(() => {
    clients = makeClients();
    mockGenerateListingCopy.mockReset();
    mockCreateProduct.mockReset();
    mockSyncFromShopify.mockReset();
  });

  it('throws ListingError when copy generation fails', async () => {
    mockGenerateListingCopy.mockRejectedValueOnce(new Error('Anthropic API unavailable'));

    await expect(publishProduct(clients, makeProduct())).rejects.toThrow(ListingError);
  });

  it('does not call Shopify or Etsy when copy generation fails', async () => {
    mockGenerateListingCopy.mockRejectedValueOnce(new Error('quota exceeded'));

    await expect(publishProduct(clients, makeProduct())).rejects.toThrow(ListingError);

    expect(mockCreateProduct).not.toHaveBeenCalled();
    expect(mockSyncFromShopify).not.toHaveBeenCalled();
  });
});

// ----------------------------------------------------------------
// 5. publishBatch — copy generation failure surfaces as failed report
// ----------------------------------------------------------------

describe('publishBatch — copy generation failure', () => {
  let clients: PublisherClients;

  beforeEach(() => {
    clients = makeClients();
    mockGenerateBatchListingCopy.mockReset();
    mockCreateProduct.mockReset();
    mockSyncFromShopify.mockReset();
  });

  it('marks both platforms as failed when a product has no copy', async () => {
    const prod1 = makeProduct({ id: 'p-1', title: 'Prod 1' });
    const prod2 = makeProduct({ id: 'p-2', title: 'Prod 2' });

    // p-1 gets copy, p-2 does not
    mockGenerateBatchListingCopy.mockResolvedValueOnce(
      new Map([['p-1', makeCopy()]]),
    );
    mockCreateProduct.mockResolvedValue('shopify-123');
    mockSyncFromShopify.mockResolvedValue(makeEtsyListingSuccess());

    const reports = await publishBatch(clients, [prod1, prod2]);

    const p2Report = reports.find((r) => r.productId === 'p-2');

    expect(p2Report).toBeDefined();
    expect(p2Report?.publishedAt).toBeNull();
    expect(p2Report?.platforms.every((p) => p.status === 'failed')).toBe(true);
  });

  it('successfully publishes the product that has copy', async () => {
    const prod1 = makeProduct({ id: 'p-ok' });
    const prod2 = makeProduct({ id: 'p-no-copy' });

    mockGenerateBatchListingCopy.mockResolvedValueOnce(
      new Map([['p-ok', makeCopy()]]),
    );
    mockCreateProduct.mockResolvedValueOnce('shopify-ok');
    mockSyncFromShopify.mockResolvedValueOnce(makeEtsyListingSuccess());

    const reports = await publishBatch(clients, [prod1, prod2]);

    const okReport = reports.find((r) => r.productId === 'p-ok');

    expect(okReport?.publishedAt).toBeInstanceOf(Date);
  });

  it('returns one report per product', async () => {
    const products = [
      makeProduct({ id: 'p-1' }),
      makeProduct({ id: 'p-2' }),
      makeProduct({ id: 'p-3' }),
    ];

    mockGenerateBatchListingCopy.mockResolvedValueOnce(new Map());

    const reports = await publishBatch(clients, products);

    expect(reports).toHaveLength(3);
  });
});

// ----------------------------------------------------------------
// 6. retryFailedListings — report merge behaviour
// ----------------------------------------------------------------

describe('retryFailedListings', () => {
  let clients: PublisherClients;

  beforeEach(() => {
    clients = makeClients();
  });

  function makeReport(
    productId: string,
    shopifyStatus: 'published' | 'failed',
    etsyStatus: 'published' | 'failed',
  ): PublicationReport {
    return {
      productId,
      copy: makeCopy(),
      platforms: [
        {
          platform: 'shopify',
          status: shopifyStatus,
          platformId: shopifyStatus === 'published' ? 'shopify-id' : null,
          errorMessage: shopifyStatus === 'failed' ? 'Shopify fail' : null,
        },
        {
          platform: 'etsy',
          status: etsyStatus,
          platformId: etsyStatus === 'published' ? 'etsy-id' : null,
          errorMessage: etsyStatus === 'failed' ? 'Etsy fail' : null,
        },
      ],
      publishedAt: shopifyStatus === 'published' && etsyStatus === 'published' ? new Date() : null,
    };
  }

  it('returns the same number of reports as input', () => {
    const reports = [
      makeReport('p-1', 'published', 'published'),
      makeReport('p-2', 'failed', 'published'),
    ];

    const result = retryFailedListings(clients, reports);

    expect(result).toHaveLength(2);
  });

  it('leaves fully-successful reports untouched', () => {
    const successReport = makeReport('p-success', 'published', 'published');
    const failReport = makeReport('p-fail', 'failed', 'published');

    const result = retryFailedListings(clients, [successReport, failReport]);

    const found = result.find((r) => r.productId === 'p-success');
    expect(found?.platforms[0]?.status).toBe('published');
    expect(found?.platforms[1]?.status).toBe('published');
  });

  it('marks retried platforms as failed with a message indicating Product is required', () => {
    const report = makeReport('p-retry', 'failed', 'published');

    const result = retryFailedListings(clients, [report]);

    const retried = result.find((r) => r.productId === 'p-retry');
    const shopifyPlatform = retried?.platforms.find((p) => p.platform === 'shopify');

    expect(shopifyPlatform?.status).toBe('failed');
    expect(shopifyPlatform?.errorMessage).toContain('publishProduct');
  });

  it('returns all reports unchanged when there are no failures', () => {
    const reports = [
      makeReport('p-1', 'published', 'published'),
      makeReport('p-2', 'published', 'published'),
    ];

    const result = retryFailedListings(clients, reports);

    expect(result).toHaveLength(2);
    for (const r of result) {
      expect(r.platforms.every((p) => p.status === 'published')).toBe(true);
    }
  });
});
