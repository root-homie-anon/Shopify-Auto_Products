// ============================================================
// Shopify Service — Unit Tests
// Focus: createShopifyClient config wiring, product/variant data
// mapping, and ShopifyError wrapping on API failure.
// External SDK (shopify-api-node) is mocked throughout.
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Product, ProductVariant, AppConfig } from '../../../types/index.js';
import { ShopifyError } from '../../../utils/errors.js';

// ----------------------------------------------------------------
// Hoist mocks so they are initialised before vi.mock() factories run
// ----------------------------------------------------------------

const {
  mockProductCreate,
  mockProductUpdate,
  mockProductGet: _mockProductGet,
  mockProductList: _mockProductList,
  mockSmartCollectionCreate,
  mockCustomCollectionCreate,
  mockFulfillmentList,
  mockFulfillmentUpdateTracking,
  MockShopify,
} = vi.hoisted(() => {
  const mockProductCreate = vi.fn();
  const mockProductUpdate = vi.fn();
  const mockProductGet = vi.fn();
  const mockProductList = vi.fn();
  const mockSmartCollectionCreate = vi.fn();
  const mockCustomCollectionCreate = vi.fn();
  const mockFulfillmentList = vi.fn();
  const mockFulfillmentUpdateTracking = vi.fn();

  const MockShopify = vi.fn().mockImplementation(() => ({
    product: {
      create: mockProductCreate,
      update: mockProductUpdate,
      get: mockProductGet,
      list: mockProductList,
    },
    smartCollection: { create: mockSmartCollectionCreate },
    customCollection: { create: mockCustomCollectionCreate },
    fulfillment: {
      list: mockFulfillmentList,
      updateTracking: mockFulfillmentUpdateTracking,
    },
  }));

  return {
    mockProductCreate,
    mockProductUpdate,
    mockProductGet,
    mockProductList,
    mockSmartCollectionCreate,
    mockCustomCollectionCreate,
    mockFulfillmentList,
    mockFulfillmentUpdateTracking,
    MockShopify,
  };
});

vi.mock('shopify-api-node', () => ({ default: MockShopify }));

// Import after mock is in place
import {
  createShopifyClient,
  createProduct,
  updateProduct,
  createCollection,
  updateOrderTracking,
} from '../index.js';

// ----------------------------------------------------------------
// Shared fixtures
// ----------------------------------------------------------------

const shopifyConfig: AppConfig['shopify'] = {
  shopName: 'banyakob-test',
  apiKey: 'key-123',
  apiSecret: 'secret-456',
  accessToken: 'token-abc',
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
    tags: ['christian apparel', 'streetwear'],
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

// ----------------------------------------------------------------
// 1. createShopifyClient
// ----------------------------------------------------------------

describe('createShopifyClient', () => {
  beforeEach(() => {
    MockShopify.mockClear();
  });

  it('passes shopName and accessToken to the SDK constructor', () => {
    createShopifyClient(shopifyConfig);

    expect(MockShopify).toHaveBeenCalledOnce();
    const callArgs = MockShopify.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(callArgs['shopName']).toBe('banyakob-test');
    expect(callArgs['accessToken']).toBe('token-abc');
  });

  it('enables autoLimit on the constructed client', () => {
    createShopifyClient(shopifyConfig);

    const callArgs = MockShopify.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(callArgs['autoLimit']).toBe(true);
  });

  it('returns the constructed Shopify instance', () => {
    const client = createShopifyClient(shopifyConfig);
    expect(client).toBeDefined();
    expect(typeof (client as unknown as Record<string, unknown>)['product']).toBe('object');
  });
});

// ----------------------------------------------------------------
// 2. Product data mapping — variant shape
// ----------------------------------------------------------------

describe('createProduct — variant mapping', () => {
  let client: ReturnType<typeof createShopifyClient>;

  beforeEach(() => {
    client = createShopifyClient(shopifyConfig);
    mockProductCreate.mockReset();
  });

  it('maps variant size and color to option1/option2', async () => {
    const variant = makeVariant({ size: 'XL', color: 'Navy' });
    const product = makeProduct({ variants: [variant] });

    mockProductCreate.mockResolvedValueOnce({ id: 111 });

    await createProduct(client, product);

    const payload = mockProductCreate.mock.calls[0]?.[0] as Record<string, unknown>;
    const variants = payload['variants'] as Array<Record<string, unknown>>;
    expect(variants[0]?.['option1']).toBe('XL');
    expect(variants[0]?.['option2']).toBe('Navy');
  });

  it('formats price as a fixed-2-decimal string', async () => {
    const variant = makeVariant({ price: 29.9 });
    const product = makeProduct({ variants: [variant] });

    mockProductCreate.mockResolvedValueOnce({ id: 222 });

    await createProduct(client, product);

    const payload = mockProductCreate.mock.calls[0]?.[0] as Record<string, unknown>;
    const variants = payload['variants'] as Array<Record<string, unknown>>;
    expect(variants[0]?.['price']).toBe('29.90');
  });

  it('maps compareAtPrice to null when not set', async () => {
    const variant = makeVariant({ compareAtPrice: null });
    const product = makeProduct({ variants: [variant] });

    mockProductCreate.mockResolvedValueOnce({ id: 333 });

    await createProduct(client, product);

    const payload = mockProductCreate.mock.calls[0]?.[0] as Record<string, unknown>;
    const variants = payload['variants'] as Array<Record<string, unknown>>;
    expect(variants[0]?.['compare_at_price']).toBeNull();
  });

  it('formats compareAtPrice as fixed-2-decimal string when set', async () => {
    const variant = makeVariant({ compareAtPrice: 39.999 });
    const product = makeProduct({ variants: [variant] });

    mockProductCreate.mockResolvedValueOnce({ id: 444 });

    await createProduct(client, product);

    const payload = mockProductCreate.mock.calls[0]?.[0] as Record<string, unknown>;
    const variants = payload['variants'] as Array<Record<string, unknown>>;
    expect(variants[0]?.['compare_at_price']).toBe('40.00');
  });

  it('sets inventory_management to "shopify" on every variant', async () => {
    const product = makeProduct({ variants: [makeVariant(), makeVariant({ size: 'L' })] });

    mockProductCreate.mockResolvedValueOnce({ id: 555 });

    await createProduct(client, product);

    const payload = mockProductCreate.mock.calls[0]?.[0] as Record<string, unknown>;
    const variants = payload['variants'] as Array<Record<string, unknown>>;
    for (const v of variants) {
      expect(v['inventory_management']).toBe('shopify');
    }
  });
});

// ----------------------------------------------------------------
// 3. Product data mapping — top-level payload shape
// ----------------------------------------------------------------

describe('createProduct — payload shape', () => {
  let client: ReturnType<typeof createShopifyClient>;

  beforeEach(() => {
    client = createShopifyClient(shopifyConfig);
    mockProductCreate.mockReset();
  });

  it('joins tags array with ", " separator', async () => {
    const product = makeProduct({ tags: ['christian apparel', 'faith based', 'streetwear'] });

    mockProductCreate.mockResolvedValueOnce({ id: 10 });

    await createProduct(client, product);

    const payload = mockProductCreate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload['tags']).toBe('christian apparel, faith based, streetwear');
  });

  it('includes front image with descriptive alt text', async () => {
    const product = makeProduct();

    mockProductCreate.mockResolvedValueOnce({ id: 20 });

    await createProduct(client, product);

    const payload = mockProductCreate.mock.calls[0]?.[0] as Record<string, unknown>;
    const images = payload['images'] as Array<{ src: string; alt: string }>;
    expect(images[0]?.src).toBe('https://cdn.test/front.jpg');
    expect(images[0]?.alt).toContain('front');
  });

  it('omits back image when backImageUrl is null', async () => {
    const product = makeProduct();

    mockProductCreate.mockResolvedValueOnce({ id: 30 });

    await createProduct(client, product);

    const payload = mockProductCreate.mock.calls[0]?.[0] as Record<string, unknown>;
    const images = payload['images'] as Array<{ src: string; alt: string }>;
    expect(images).toHaveLength(1);
  });

  it('appends back image at index 1 when backImageUrl is present', async () => {
    const product = makeProduct({
      design: {
        id: 'design-001',
        name: 'Archangel Michael',
        frontImageUrl: 'https://cdn.test/front.jpg',
        backImageUrl: 'https://cdn.test/back.jpg',
        createdAt: new Date('2025-01-01'),
        approvedAt: null,
      },
    });

    mockProductCreate.mockResolvedValueOnce({ id: 40 });

    await createProduct(client, product);

    const payload = mockProductCreate.mock.calls[0]?.[0] as Record<string, unknown>;
    const images = payload['images'] as Array<{ src: string; alt: string }>;
    expect(images).toHaveLength(2);
    expect(images[1]?.src).toBe('https://cdn.test/back.jpg');
    expect(images[1]?.alt).toContain('back');
  });

  it('builds product options from variant grid', async () => {
    const variants: ProductVariant[] = [
      makeVariant({ size: 'S', color: 'Black' }),
      makeVariant({ size: 'M', color: 'Black' }),
      makeVariant({ size: 'S', color: 'White' }),
    ];
    const product = makeProduct({ variants });

    mockProductCreate.mockResolvedValueOnce({ id: 50 });

    await createProduct(client, product);

    const payload = mockProductCreate.mock.calls[0]?.[0] as Record<string, unknown>;
    const options = payload['options'] as Array<{ name: string; values: string[] }>;
    const sizeOption = options.find((o) => o.name === 'Size');
    const colorOption = options.find((o) => o.name === 'Color');

    expect(sizeOption?.values).toEqual(expect.arrayContaining(['S', 'M']));
    expect(colorOption?.values).toEqual(expect.arrayContaining(['Black', 'White']));
    // Deduplication — S appears twice in variants but only once in options
    expect(sizeOption?.values).toHaveLength(2);
  });

  it('truncates seo description to 320 chars in metafields_global_description_tag', async () => {
    const longDesc = 'x'.repeat(400);
    const product = makeProduct({ description: longDesc });

    mockProductCreate.mockResolvedValueOnce({ id: 60 });

    await createProduct(client, product);

    const payload = mockProductCreate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect((payload['metafields_global_description_tag'] as string).length).toBe(320);
  });

  it('returns the Shopify ID as a string', async () => {
    mockProductCreate.mockResolvedValueOnce({ id: 9876543210 });

    const result = await createProduct(client, makeProduct());

    expect(result).toBe('9876543210');
  });
});

// ----------------------------------------------------------------
// 4. Error wrapping — ShopifyError thrown on API failure
// ----------------------------------------------------------------

describe('createProduct — error wrapping', () => {
  let client: ReturnType<typeof createShopifyClient>;

  beforeEach(() => {
    client = createShopifyClient(shopifyConfig);
    mockProductCreate.mockReset();
  });

  it('throws ShopifyError when client.product.create rejects with an Error', async () => {
    mockProductCreate.mockRejectedValueOnce(new Error('Unprocessable Entity'));

    await expect(createProduct(client, makeProduct())).rejects.toThrow(ShopifyError);
  });

  it('includes the original error message in the ShopifyError message', async () => {
    mockProductCreate.mockRejectedValueOnce(new Error('rate limit exceeded'));

    await expect(createProduct(client, makeProduct())).rejects.toThrow('rate limit exceeded');
  });

  it('throws ShopifyError when client.product.create rejects with a non-Error value', async () => {
    mockProductCreate.mockRejectedValueOnce('plain string error');

    await expect(createProduct(client, makeProduct())).rejects.toThrow(ShopifyError);
  });

  it('includes "unknown error" in message when cause is a non-Error value', async () => {
    mockProductCreate.mockRejectedValueOnce(42);

    await expect(createProduct(client, makeProduct())).rejects.toThrow('unknown error');
  });
});

describe('updateProduct — error wrapping', () => {
  let client: ReturnType<typeof createShopifyClient>;

  beforeEach(() => {
    client = createShopifyClient(shopifyConfig);
    mockProductUpdate.mockReset();
  });

  it('throws ShopifyError on update failure', async () => {
    mockProductUpdate.mockRejectedValueOnce(new Error('Not Found'));

    await expect(updateProduct(client, '999', { title: 'New Title' })).rejects.toThrow(ShopifyError);
  });
});

// ----------------------------------------------------------------
// 5. createCollection — smart vs custom routing
// ----------------------------------------------------------------

describe('createCollection', () => {
  let client: ReturnType<typeof createShopifyClient>;

  beforeEach(() => {
    client = createShopifyClient(shopifyConfig);
    mockSmartCollectionCreate.mockReset();
    mockCustomCollectionCreate.mockReset();
  });

  it('creates a custom collection when no rules are provided', async () => {
    mockCustomCollectionCreate.mockResolvedValueOnce({ id: 1, title: 'Tees' });

    await createCollection(client, 'Tees');

    expect(mockCustomCollectionCreate).toHaveBeenCalledOnce();
    expect(mockSmartCollectionCreate).not.toHaveBeenCalled();
  });

  it('creates a custom collection when an empty rules array is provided', async () => {
    mockCustomCollectionCreate.mockResolvedValueOnce({ id: 2, title: 'Hoodies' });

    await createCollection(client, 'Hoodies', []);

    expect(mockCustomCollectionCreate).toHaveBeenCalledOnce();
    expect(mockSmartCollectionCreate).not.toHaveBeenCalled();
  });

  it('creates a smart collection when rules are provided', async () => {
    mockSmartCollectionCreate.mockResolvedValueOnce({ id: 3, title: 'Sale' });

    await createCollection(client, 'Sale', [
      { column: 'variant_price', relation: 'less_than', condition: '20' },
    ]);

    expect(mockSmartCollectionCreate).toHaveBeenCalledOnce();
    expect(mockCustomCollectionCreate).not.toHaveBeenCalled();
  });

  it('passes the rules to the smart collection create call', async () => {
    const rules = [{ column: 'tag' as const, relation: 'equals' as const, condition: 'sale' }];
    mockSmartCollectionCreate.mockResolvedValueOnce({ id: 4, title: 'Tagged Sale' });

    await createCollection(client, 'Tagged Sale', rules);

    const callArgs = mockSmartCollectionCreate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(callArgs['rules']).toEqual(rules);
  });

  it('wraps smart collection errors in ShopifyError', async () => {
    mockSmartCollectionCreate.mockRejectedValueOnce(new Error('Forbidden'));

    await expect(
      createCollection(client, 'Fail', [{ column: 'tag', relation: 'equals', condition: 'x' }]),
    ).rejects.toThrow(ShopifyError);
  });
});

// ----------------------------------------------------------------
// 6. updateOrderTracking — fulfillment ID resolution & error paths
// ----------------------------------------------------------------

describe('updateOrderTracking', () => {
  let client: ReturnType<typeof createShopifyClient>;

  beforeEach(() => {
    client = createShopifyClient(shopifyConfig);
    mockFulfillmentList.mockReset();
    mockFulfillmentUpdateTracking.mockReset();
  });

  it('throws ShopifyError when no fulfillments exist for the order', async () => {
    mockFulfillmentList.mockResolvedValueOnce([]);

    await expect(
      updateOrderTracking(client, '12345', 'TRACK123', 'https://track.test/TRACK123'),
    ).rejects.toThrow(ShopifyError);
  });

  it('includes the order ID in the error message when no fulfillments found', async () => {
    mockFulfillmentList.mockResolvedValueOnce([]);

    await expect(
      updateOrderTracking(client, '99999', 'TRACK', 'https://track.test'),
    ).rejects.toThrow('99999');
  });

  it('calls updateTracking with the first fulfillment ID', async () => {
    const firstFulfillment = { id: 777 };
    mockFulfillmentList.mockResolvedValueOnce([firstFulfillment, { id: 888 }]);
    mockFulfillmentUpdateTracking.mockResolvedValueOnce({ id: 777 });

    await updateOrderTracking(client, '12345', 'TRK001', 'https://track.test/TRK001');

    expect(mockFulfillmentUpdateTracking).toHaveBeenCalledWith(
      777,
      expect.objectContaining({
        tracking_info: { number: 'TRK001', url: 'https://track.test/TRK001' },
        notify_customer: true,
      }),
    );
  });

  it('throws ShopifyError when fulfillment list fetch fails', async () => {
    mockFulfillmentList.mockRejectedValueOnce(new Error('API error'));

    await expect(
      updateOrderTracking(client, '12345', 'TRK', 'https://track.test'),
    ).rejects.toThrow(ShopifyError);
  });

  it('throws ShopifyError when updateTracking call fails', async () => {
    mockFulfillmentList.mockResolvedValueOnce([{ id: 100 }]);
    mockFulfillmentUpdateTracking.mockRejectedValueOnce(new Error('Network timeout'));

    await expect(
      updateOrderTracking(client, '12345', 'TRK', 'https://track.test'),
    ).rejects.toThrow(ShopifyError);
  });
});
