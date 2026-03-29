// ============================================================
// CustomCat Service — Unit Tests
// Focus: CC_STATUS_MAP coverage, order payload construction,
// network/API error handling from customCatFetch.
// node-fetch is mocked via vi.hoisted(); internal mapping
// helpers are tested via public functions that exercise them.
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Order, AppConfig } from '../../../types/index.js';
import { CustomCatError } from '../../../utils/errors.js';

// ----------------------------------------------------------------
// Hoist mock before vi.mock() factory runs
// ----------------------------------------------------------------

const { mockFetch } = vi.hoisted(() => {
  return { mockFetch: vi.fn() };
});

vi.mock('node-fetch', () => ({ default: mockFetch }));

// Import after mock
import {
  createCustomCatClient,
  submitOrder,
  getOrderStatus,
} from '../index.js';
import type { OrderLineItemWithPrintFiles } from '../index.js';

// ----------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------

const customcatConfig: AppConfig['customcat'] = {
  apiKey: 'cc-key-123',
  apiUrl: 'https://api.customcat.test',
};

function makeOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: 'order-001',
    shopifyOrderId: 'shopify-111',
    customcatOrderId: null,
    lineItems: [],
    shippingAddress: {
      name: 'John Doe',
      address1: '123 Main St',
      address2: null,
      city: 'Springfield',
      province: 'IL',
      zip: '62701',
      country: 'US',
    },
    status: 'received',
    trackingNumber: null,
    trackingUrl: null,
    createdAt: new Date('2025-03-01'),
    updatedAt: new Date('2025-03-01'),
    ...overrides,
  };
}

function makeLineItemWithPrintFiles(
  overrides: Partial<OrderLineItemWithPrintFiles> = {},
): OrderLineItemWithPrintFiles {
  return {
    sku: 'BC-3001-M-BLK',
    quantity: 1,
    size: 'M',
    color: 'Black',
    designId: 'design-001',
    frontPrintFileUrl: 'https://cdn.test/front.png',
    backPrintFileUrl: null,
    ...overrides,
  };
}

function makeJsonResponse(body: unknown, status = 200): object {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
  };
}

// ----------------------------------------------------------------
// 1. createCustomCatClient
// ----------------------------------------------------------------

describe('createCustomCatClient', () => {
  it('returns a client with the configured apiKey', () => {
    const client = createCustomCatClient(customcatConfig);
    expect(client.apiKey).toBe('cc-key-123');
  });

  it('returns a client with the configured baseUrl', () => {
    const client = createCustomCatClient(customcatConfig);
    expect(client.baseUrl).toBe('https://api.customcat.test');
  });
});

// ----------------------------------------------------------------
// 2. Status mapping — CC_STATUS_MAP coverage
// ----------------------------------------------------------------

describe('getOrderStatus — CC_STATUS_MAP', () => {
  let client: ReturnType<typeof createCustomCatClient>;

  beforeEach(() => {
    client = createCustomCatClient(customcatConfig);
    mockFetch.mockReset();
  });

  const statusCases: Array<[string, string]> = [
    ['received', 'received'],
    ['pending', 'received'],
    ['processing', 'in_production'],
    ['in_production', 'in_production'],
    ['printed', 'in_production'],
    ['shipped', 'shipped'],
    ['delivered', 'delivered'],
    ['cancelled', 'cancelled'],
    ['error', 'error'],
    ['failed', 'error'],
  ];

  it.each(statusCases)(
    'maps CC status "%s" to OrderStatus "%s"',
    async (ccStatus, expectedOrderStatus) => {
      mockFetch.mockResolvedValueOnce(
        makeJsonResponse({ id: 'cc-001', status: ccStatus, updated_at: '2025-03-01' }),
      );

      const result = await getOrderStatus(client, 'cc-001');

      expect(result).toBe(expectedOrderStatus);
    },
  );

  it('normalises CC status to lowercase before mapping', async () => {
    mockFetch.mockResolvedValueOnce(
      makeJsonResponse({ id: 'cc-002', status: 'SHIPPED', updated_at: '2025-03-01' }),
    );

    const result = await getOrderStatus(client, 'cc-002');

    expect(result).toBe('shipped');
  });

  it('normalises CC status by trimming whitespace', async () => {
    mockFetch.mockResolvedValueOnce(
      makeJsonResponse({ id: 'cc-003', status: '  delivered  ', updated_at: '2025-03-01' }),
    );

    const result = await getOrderStatus(client, 'cc-003');

    expect(result).toBe('delivered');
  });

  it('falls back to "error" for an unrecognised CC status', async () => {
    mockFetch.mockResolvedValueOnce(
      makeJsonResponse({ id: 'cc-004', status: 'unknown_status_xyz', updated_at: '2025-03-01' }),
    );

    const result = await getOrderStatus(client, 'cc-004');

    expect(result).toBe('error');
  });
});

// ----------------------------------------------------------------
// 3. Order payload construction — submitOrder
// ----------------------------------------------------------------

describe('submitOrder — payload construction', () => {
  let client: ReturnType<typeof createCustomCatClient>;

  beforeEach(() => {
    client = createCustomCatClient(customcatConfig);
    mockFetch.mockReset();
  });

  it('maps Order.shippingAddress.province to state in payload', async () => {
    mockFetch.mockResolvedValueOnce(makeJsonResponse({ id: 'cc-100', external_id: 'shopify-111', status: 'received', created_at: '2025-03-01' }));

    const order = makeOrder();
    const lineItems = [makeLineItemWithPrintFiles()];

    await submitOrder(client, order, lineItems);

    const fetchCall = mockFetch.mock.calls[0];
    const fetchBody = JSON.parse((fetchCall?.[1] as Record<string, unknown>)['body'] as string) as Record<string, unknown>;
    const shippingAddr = fetchBody['shipping_address'] as Record<string, unknown>;

    expect(shippingAddr['state']).toBe('IL');
  });

  it('maps address2: null correctly to the payload', async () => {
    mockFetch.mockResolvedValueOnce(makeJsonResponse({ id: 'cc-101', external_id: 'shopify-111', status: 'received', created_at: '2025-03-01' }));

    const order = makeOrder({ shippingAddress: { ...makeOrder().shippingAddress, address2: null } });

    await submitOrder(client, order, [makeLineItemWithPrintFiles()]);

    const fetchCall = mockFetch.mock.calls[0];
    const fetchBody = JSON.parse((fetchCall?.[1] as Record<string, unknown>)['body'] as string) as Record<string, unknown>;
    const shippingAddr = fetchBody['shipping_address'] as Record<string, unknown>;

    expect(shippingAddr['address2']).toBeNull();
  });

  it('sets external_id to order.shopifyOrderId', async () => {
    mockFetch.mockResolvedValueOnce(makeJsonResponse({ id: 'cc-102', external_id: 'shopify-999', status: 'received', created_at: '2025-03-01' }));

    const order = makeOrder({ shopifyOrderId: 'shopify-999' });

    await submitOrder(client, order, [makeLineItemWithPrintFiles()]);

    const fetchCall = mockFetch.mock.calls[0];
    const fetchBody = JSON.parse((fetchCall?.[1] as Record<string, unknown>)['body'] as string) as Record<string, unknown>;

    expect(fetchBody['external_id']).toBe('shopify-999');
  });

  it('maps line item sku, quantity, size, color to CC shape', async () => {
    mockFetch.mockResolvedValueOnce(makeJsonResponse({ id: 'cc-103', external_id: 'shopify-111', status: 'received', created_at: '2025-03-01' }));

    const lineItem = makeLineItemWithPrintFiles({
      sku: 'BC-3001-L-WHT',
      quantity: 2,
      size: 'L',
      color: 'White',
    });

    await submitOrder(client, makeOrder(), [lineItem]);

    const fetchCall = mockFetch.mock.calls[0];
    const fetchBody = JSON.parse((fetchCall?.[1] as Record<string, unknown>)['body'] as string) as Record<string, unknown>;
    const lineItems = fetchBody['line_items'] as Array<Record<string, unknown>>;

    expect(lineItems[0]?.['sku']).toBe('BC-3001-L-WHT');
    expect(lineItems[0]?.['quantity']).toBe(2);
    expect(lineItems[0]?.['size']).toBe('L');
    expect(lineItems[0]?.['color']).toBe('White');
  });

  it('maps frontPrintFileUrl and backPrintFileUrl to print_files', async () => {
    mockFetch.mockResolvedValueOnce(makeJsonResponse({ id: 'cc-104', external_id: 'shopify-111', status: 'received', created_at: '2025-03-01' }));

    const lineItem = makeLineItemWithPrintFiles({
      frontPrintFileUrl: 'https://cdn.test/front.png',
      backPrintFileUrl: 'https://cdn.test/back.png',
    });

    await submitOrder(client, makeOrder(), [lineItem]);

    const fetchCall = mockFetch.mock.calls[0];
    const fetchBody = JSON.parse((fetchCall?.[1] as Record<string, unknown>)['body'] as string) as Record<string, unknown>;
    const lineItems = fetchBody['line_items'] as Array<Record<string, unknown>>;
    const printFiles = lineItems[0]?.['print_files'] as Record<string, unknown>;

    expect(printFiles['front']).toBe('https://cdn.test/front.png');
    expect(printFiles['back']).toBe('https://cdn.test/back.png');
  });

  it('returns the CustomCat order ID from the response', async () => {
    mockFetch.mockResolvedValueOnce(makeJsonResponse({ id: 'cc-assigned-id', external_id: 'shopify-111', status: 'received', created_at: '2025-03-01' }));

    const result = await submitOrder(client, makeOrder(), [makeLineItemWithPrintFiles()]);

    expect(result).toBe('cc-assigned-id');
  });
});

// ----------------------------------------------------------------
// 4. submitOrder — validation and error handling
// ----------------------------------------------------------------

describe('submitOrder — validation', () => {
  let client: ReturnType<typeof createCustomCatClient>;

  beforeEach(() => {
    client = createCustomCatClient(customcatConfig);
    mockFetch.mockReset();
  });

  it('throws CustomCatError immediately when lineItems is empty', async () => {
    await expect(submitOrder(client, makeOrder(), [])).rejects.toThrow(CustomCatError);
  });

  it('includes the order ID in the empty-lineItems error message', async () => {
    const order = makeOrder({ id: 'order-xyz' });

    await expect(submitOrder(client, order, [])).rejects.toThrow('order-xyz');
  });

  it('throws CustomCatError when the response contains no id field', async () => {
    // Response is ok but missing id
    mockFetch.mockResolvedValueOnce(makeJsonResponse({ external_id: 'shopify-111', status: 'received', created_at: '2025-03-01' }));

    await expect(submitOrder(client, makeOrder(), [makeLineItemWithPrintFiles()])).rejects.toThrow(CustomCatError);
  });
});

// ----------------------------------------------------------------
// 5. Network / API error handling
// ----------------------------------------------------------------

describe('customCatFetch — error handling (via getOrderStatus)', () => {
  let client: ReturnType<typeof createCustomCatClient>;

  beforeEach(() => {
    client = createCustomCatClient(customcatConfig);
    mockFetch.mockReset();
  });

  it('throws CustomCatError when fetch itself throws (network failure)', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    await expect(getOrderStatus(client, 'cc-001')).rejects.toThrow(CustomCatError);
  });

  it('includes the network error message in the thrown CustomCatError', async () => {
    mockFetch.mockRejectedValueOnce(new Error('DNS lookup failed'));

    await expect(getOrderStatus(client, 'cc-001')).rejects.toThrow('DNS lookup failed');
  });

  it('throws CustomCatError on a non-2xx HTTP response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: vi.fn().mockResolvedValue('Not found'),
    });

    await expect(getOrderStatus(client, 'cc-999')).rejects.toThrow(CustomCatError);
  });

  it('includes HTTP status in error message for non-2xx responses', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: vi.fn().mockResolvedValue('Internal Server Error'),
    });

    await expect(getOrderStatus(client, 'cc-999')).rejects.toThrow('500');
  });

  it('throws CustomCatError when JSON parsing of the response fails', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn().mockRejectedValue(new SyntaxError('Unexpected token')),
    });

    await expect(getOrderStatus(client, 'cc-001')).rejects.toThrow(CustomCatError);
  });
});
