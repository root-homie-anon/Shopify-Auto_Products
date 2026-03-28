// ============================================================
// Etsy Service — Unit Tests
// Focus: tag truncation to 13 max, price resolution (min variant
// price), listing state mapping (ProductStatus → EtsyListingState).
// fetch is mocked via vi.stubGlobal so etsyFetch network calls
// are intercepted without importing from a separate module.
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Product, ProductVariant, AppConfig, ListingCopy } from '../../../types/index.js';
import { EtsyError } from '../../../utils/errors.js';

// ----------------------------------------------------------------
// Mock global fetch used by etsyFetch inside the Etsy service
// ----------------------------------------------------------------

const mockGlobalFetch = vi.fn();

vi.stubGlobal('fetch', mockGlobalFetch);

// Import after stub is registered
import {
  createEtsyClient,
  createListing,
  updateListing,
} from '../index.js';
import type { EtsyListingResponse } from '../index.js';

// ----------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------

const etsyConfig: AppConfig['etsy'] = {
  apiKey: 'etsy-key-123',
  apiSecret: 'etsy-secret',
  accessToken: 'etsy-token-abc',
  shopId: 'shop-7777',
};

function makeVariant(overrides: Partial<ProductVariant> = {}): ProductVariant {
  return {
    size: 'M',
    color: 'Black',
    sku: 'TEST-M-BLK',
    price: 29.99,
    compareAtPrice: null,
    inventoryQuantity: 50,
    ...overrides,
  };
}

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
    variants: [makeVariant()],
    tags: ['christian apparel', 'faith'],
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
    description: '<p>Sacred art.</p>',
    tags: ['christian apparel', 'byzantine art'],
    seoTitle: 'Archangel Michael Christian T-Shirt | Banyakob',
    seoDescription: 'Faith apparel by Banyakob.',
    ...overrides,
  };
}

function makeEtsyListingResponse(overrides: Partial<EtsyListingResponse> = {}): EtsyListingResponse {
  return {
    listing_id: 123456789,
    title: 'Test Listing',
    description: 'Test description',
    price: { amount: 2999, divisor: 100, currency_code: 'USD' },
    tags: ['tag1'],
    state: 'active',
    url: 'https://www.etsy.com/listing/123456789',
    images: [],
    ...overrides,
  };
}

function makeJsonFetchResponse(body: unknown, status = 200): ReturnType<typeof mockGlobalFetch> {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
    headers: { get: vi.fn().mockReturnValue(null) },
  });
}

// ----------------------------------------------------------------
// 1. createEtsyClient
// ----------------------------------------------------------------

describe('createEtsyClient', () => {
  it('returns a client with all credentials set', () => {
    const client = createEtsyClient(etsyConfig);

    expect(client.apiKey).toBe('etsy-key-123');
    expect(client.accessToken).toBe('etsy-token-abc');
    expect(client.shopId).toBe('shop-7777');
  });

  it('sets baseUrl to the Etsy v3 API URL', () => {
    const client = createEtsyClient(etsyConfig);

    expect(client.baseUrl).toBe('https://api.etsy.com/v3');
  });
});

// ----------------------------------------------------------------
// 2. Tag truncation — ETSY_MAX_TAGS = 13
// ----------------------------------------------------------------

describe('createListing — tag truncation', () => {
  let client: ReturnType<typeof createEtsyClient>;

  beforeEach(() => {
    client = createEtsyClient(etsyConfig);
    mockGlobalFetch.mockReset();
  });

  it('sends all tags when count is exactly 13', async () => {
    const tags = Array.from({ length: 13 }, (_, i) => `tag-${String(i)}`);
    const copy = makeCopy({ tags });
    mockGlobalFetch.mockReturnValueOnce(makeJsonFetchResponse(makeEtsyListingResponse()));

    await createListing(client, makeProduct(), copy);

    const fetchCall = mockGlobalFetch.mock.calls[0];
    const sentBody = JSON.parse((fetchCall?.[1] as Record<string, unknown>)['body'] as string) as Record<string, unknown>;

    expect((sentBody['tags'] as string[]).length).toBe(13);
  });

  it('truncates tags to 13 when count exceeds 13', async () => {
    const tags = Array.from({ length: 20 }, (_, i) => `tag-${String(i)}`);
    const copy = makeCopy({ tags });
    mockGlobalFetch.mockReturnValueOnce(makeJsonFetchResponse(makeEtsyListingResponse()));

    await createListing(client, makeProduct(), copy);

    const fetchCall = mockGlobalFetch.mock.calls[0];
    const sentBody = JSON.parse((fetchCall?.[1] as Record<string, unknown>)['body'] as string) as Record<string, unknown>;

    expect((sentBody['tags'] as string[]).length).toBe(13);
  });

  it('keeps the first 13 tags (earliest tags take precedence)', async () => {
    const tags = Array.from({ length: 20 }, (_, i) => `tag-${String(i)}`);
    const copy = makeCopy({ tags });
    mockGlobalFetch.mockReturnValueOnce(makeJsonFetchResponse(makeEtsyListingResponse()));

    await createListing(client, makeProduct(), copy);

    const fetchCall = mockGlobalFetch.mock.calls[0];
    const sentBody = JSON.parse((fetchCall?.[1] as Record<string, unknown>)['body'] as string) as Record<string, unknown>;
    const sentTags = sentBody['tags'] as string[];

    expect(sentTags[0]).toBe('tag-0');
    expect(sentTags[12]).toBe('tag-12');
  });

  it('sends all tags when count is below 13', async () => {
    const tags = ['tag-a', 'tag-b', 'tag-c'];
    const copy = makeCopy({ tags });
    mockGlobalFetch.mockReturnValueOnce(makeJsonFetchResponse(makeEtsyListingResponse()));

    await createListing(client, makeProduct(), copy);

    const fetchCall = mockGlobalFetch.mock.calls[0];
    const sentBody = JSON.parse((fetchCall?.[1] as Record<string, unknown>)['body'] as string) as Record<string, unknown>;

    expect(sentBody['tags']).toEqual(['tag-a', 'tag-b', 'tag-c']);
  });
});

describe('updateListing — tag truncation', () => {
  let client: ReturnType<typeof createEtsyClient>;

  beforeEach(() => {
    client = createEtsyClient(etsyConfig);
    mockGlobalFetch.mockReset();
  });

  it('truncates tags to 13 when updating', async () => {
    const tags = Array.from({ length: 15 }, (_, i) => `update-tag-${String(i)}`);
    mockGlobalFetch.mockReturnValueOnce(makeJsonFetchResponse(makeEtsyListingResponse()));

    await updateListing(client, '999', { tags });

    const fetchCall = mockGlobalFetch.mock.calls[0];
    const sentBody = JSON.parse((fetchCall?.[1] as Record<string, unknown>)['body'] as string) as Record<string, unknown>;

    expect((sentBody['tags'] as string[]).length).toBe(13);
  });
});

// ----------------------------------------------------------------
// 3. Price resolution — minimum variant price
// ----------------------------------------------------------------

describe('createListing — price resolution', () => {
  let client: ReturnType<typeof createEtsyClient>;

  beforeEach(() => {
    client = createEtsyClient(etsyConfig);
    mockGlobalFetch.mockReset();
  });

  it('uses the minimum variant price when multiple variants exist', async () => {
    const variants: ProductVariant[] = [
      makeVariant({ price: 35.00 }),
      makeVariant({ price: 29.99, size: 'S' }),
      makeVariant({ price: 32.50, size: 'L' }),
    ];
    const product = makeProduct({ variants });
    mockGlobalFetch.mockReturnValueOnce(makeJsonFetchResponse(makeEtsyListingResponse()));

    await createListing(client, product, makeCopy());

    const fetchCall = mockGlobalFetch.mock.calls[0];
    const sentBody = JSON.parse((fetchCall?.[1] as Record<string, unknown>)['body'] as string) as Record<string, unknown>;

    expect(sentBody['price']).toBe(29.99);
  });

  it('uses the single variant price when only one variant exists', async () => {
    const product = makeProduct({ variants: [makeVariant({ price: 24.99 })] });
    mockGlobalFetch.mockReturnValueOnce(makeJsonFetchResponse(makeEtsyListingResponse()));

    await createListing(client, product, makeCopy());

    const fetchCall = mockGlobalFetch.mock.calls[0];
    const sentBody = JSON.parse((fetchCall?.[1] as Record<string, unknown>)['body'] as string) as Record<string, unknown>;

    expect(sentBody['price']).toBe(24.99);
  });

  it('throws EtsyError when the product has no variants', async () => {
    const product = makeProduct({ variants: [] });

    await expect(createListing(client, product, makeCopy())).rejects.toThrow(EtsyError);
  });

  it('includes the product ID in the no-variants error message', async () => {
    const product = makeProduct({ id: 'no-variant-prod', variants: [] });

    await expect(createListing(client, product, makeCopy())).rejects.toThrow('no-variant-prod');
  });
});

// ----------------------------------------------------------------
// 4. Listing state mapping — ProductStatus → EtsyListingState
// ----------------------------------------------------------------

describe('createListing — listing state mapping', () => {
  let client: ReturnType<typeof createEtsyClient>;

  beforeEach(() => {
    client = createEtsyClient(etsyConfig);
    mockGlobalFetch.mockReset();
  });

  it('maps ProductStatus "active" to Etsy state "active"', async () => {
    const product = makeProduct({ status: 'active' });
    mockGlobalFetch.mockReturnValueOnce(makeJsonFetchResponse(makeEtsyListingResponse()));

    await createListing(client, product, makeCopy());

    const fetchCall = mockGlobalFetch.mock.calls[0];
    const sentBody = JSON.parse((fetchCall?.[1] as Record<string, unknown>)['body'] as string) as Record<string, unknown>;

    expect(sentBody['state']).toBe('active');
  });

  it('maps ProductStatus "draft" to Etsy state "draft"', async () => {
    const product = makeProduct({ status: 'draft' });
    mockGlobalFetch.mockReturnValueOnce(makeJsonFetchResponse(makeEtsyListingResponse()));

    await createListing(client, product, makeCopy());

    const fetchCall = mockGlobalFetch.mock.calls[0];
    const sentBody = JSON.parse((fetchCall?.[1] as Record<string, unknown>)['body'] as string) as Record<string, unknown>;

    expect(sentBody['state']).toBe('draft');
  });

  it('maps ProductStatus "archived" to Etsy state "inactive"', async () => {
    const product = makeProduct({ status: 'archived' });
    mockGlobalFetch.mockReturnValueOnce(makeJsonFetchResponse(makeEtsyListingResponse()));

    await createListing(client, product, makeCopy());

    const fetchCall = mockGlobalFetch.mock.calls[0];
    const sentBody = JSON.parse((fetchCall?.[1] as Record<string, unknown>)['body'] as string) as Record<string, unknown>;

    // Etsy has no 'archived' state — archived maps to 'inactive'
    expect(sentBody['state']).toBe('inactive');
  });
});

describe('updateListing — listing state mapping', () => {
  let client: ReturnType<typeof createEtsyClient>;

  beforeEach(() => {
    client = createEtsyClient(etsyConfig);
    mockGlobalFetch.mockReset();
  });

  it('maps ProductStatus "archived" to Etsy state "inactive" on update', async () => {
    mockGlobalFetch.mockReturnValueOnce(makeJsonFetchResponse(makeEtsyListingResponse()));

    await updateListing(client, '888', { status: 'archived' });

    const fetchCall = mockGlobalFetch.mock.calls[0];
    const sentBody = JSON.parse((fetchCall?.[1] as Record<string, unknown>)['body'] as string) as Record<string, unknown>;

    expect(sentBody['state']).toBe('inactive');
  });

  it('omits state from payload when status is not provided', async () => {
    mockGlobalFetch.mockReturnValueOnce(makeJsonFetchResponse(makeEtsyListingResponse()));

    await updateListing(client, '888', { title: 'New Title Only' });

    const fetchCall = mockGlobalFetch.mock.calls[0];
    const sentBody = JSON.parse((fetchCall?.[1] as Record<string, unknown>)['body'] as string) as Record<string, unknown>;

    expect('state' in sentBody).toBe(false);
  });
});

// ----------------------------------------------------------------
// 5. etsyFetch — error handling
// ----------------------------------------------------------------

describe('etsyFetch — error handling (via createListing)', () => {
  let client: ReturnType<typeof createEtsyClient>;

  beforeEach(() => {
    client = createEtsyClient(etsyConfig);
    mockGlobalFetch.mockReset();
  });

  it('throws EtsyError on non-2xx response', async () => {
    mockGlobalFetch.mockReturnValueOnce(
      Promise.resolve({
        ok: false,
        status: 422,
        json: vi.fn().mockResolvedValue({ error: 'Invalid listing data', error_description: undefined }),
      }),
    );

    await expect(createListing(client, makeProduct(), makeCopy())).rejects.toThrow(EtsyError);
  });

  it('throws EtsyError when fetch itself throws (network failure)', async () => {
    mockGlobalFetch.mockRejectedValueOnce(new Error('Connection refused'));

    await expect(createListing(client, makeProduct(), makeCopy())).rejects.toThrow(EtsyError);
  });

  it('returns the listing ID as a string', async () => {
    mockGlobalFetch.mockReturnValueOnce(
      makeJsonFetchResponse(makeEtsyListingResponse({ listing_id: 987654321 })),
    );

    const result = await createListing(client, makeProduct(), makeCopy());

    expect(result).toBe('987654321');
  });
});
