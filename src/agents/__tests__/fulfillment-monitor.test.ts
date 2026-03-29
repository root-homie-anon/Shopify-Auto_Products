// ============================================================
// Fulfillment Monitor Agent — Unit Tests
// Focus: checkSlaCompliance (pure function, all SLA levels),
// countBusinessDays (weekend skipping), loadFulfillmentState
// and saveFulfillmentState (mocked fs).
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Order } from '../../types/index.js';
import { FulfillmentError } from '../../utils/errors.js';

// ----------------------------------------------------------------
// Hoist fs mock before vi.mock() factory runs
// ----------------------------------------------------------------

const { mockReadFile, mockWriteFile, mockMkdir } = vi.hoisted(() => {
  return {
    mockReadFile: vi.fn(),
    mockWriteFile: vi.fn(),
    mockMkdir: vi.fn(),
  };
});

vi.mock('fs', () => ({
  promises: {
    readFile: mockReadFile,
    writeFile: mockWriteFile,
    mkdir: mockMkdir,
  },
}));

// Mock node-fetch to prevent real network calls
vi.mock('node-fetch', () => ({ default: vi.fn() }));

// Mock services so the agent doesn't try real API connections
vi.mock('../../services/customcat/index.js', () => ({
  createCustomCatClient: vi.fn().mockReturnValue({ apiKey: 'x', baseUrl: 'y' }),
  getOrderStatus: vi.fn(),
  getTrackingInfo: vi.fn(),
}));

vi.mock('../../services/shopify/index.js', () => ({
  createShopifyClient: vi.fn().mockReturnValue({}),
  getOrders: vi.fn(),
  updateOrderTracking: vi.fn(),
}));

// Import agent after mocks
import {
  checkSlaCompliance,
  loadFulfillmentState,
  saveFulfillmentState,
} from '../../agents/fulfillment-monitor.js';
import type { FulfillmentState } from '../../agents/fulfillment-monitor.js';

// ----------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------

function makeOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: 'order-001',
    shopifyOrderId: 'shopify-111',
    customcatOrderId: 'cc-001',
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
    status: 'in_production',
    trackingNumber: null,
    trackingUrl: null,
    createdAt: new Date('2025-03-01T00:00:00Z'),
    updatedAt: new Date('2025-03-01T00:00:00Z'),
    ...overrides,
  };
}

// ----------------------------------------------------------------
// 1. checkSlaCompliance — terminal statuses
// ----------------------------------------------------------------

describe('checkSlaCompliance — terminal statuses', () => {
  it('returns level "critical" when order status is "error"', () => {
    const order = makeOrder({ status: 'error' });

    const result = checkSlaCompliance(order);

    expect(result.level).toBe('critical');
  });

  it('returns level "critical" when order status is "cancelled"', () => {
    const order = makeOrder({ status: 'cancelled' });

    const result = checkSlaCompliance(order);

    expect(result.level).toBe('critical');
  });

  it('includes the order ID in the critical message', () => {
    const order = makeOrder({ id: 'order-xyz', status: 'error' });

    const result = checkSlaCompliance(order);

    expect(result.message).toContain('order-xyz');
  });

  it('reports businessDaysInProduction as 0 for critical statuses', () => {
    const order = makeOrder({ status: 'cancelled' });

    const result = checkSlaCompliance(order);

    expect(result.businessDaysInProduction).toBe(0);
  });
});

// ----------------------------------------------------------------
// 2. checkSlaCompliance — non-production statuses
// ----------------------------------------------------------------

describe('checkSlaCompliance — non-production statuses', () => {
  const nonProductionStatuses = ['received', 'sent_to_fulfillment', 'shipped', 'delivered'] as const;

  it.each(nonProductionStatuses)(
    'returns level "ok" when order status is "%s"',
    (status) => {
      const order = makeOrder({ status });

      const result = checkSlaCompliance(order);

      expect(result.level).toBe('ok');
      expect(result.businessDaysInProduction).toBe(0);
    },
  );
});

// ----------------------------------------------------------------
// 3. checkSlaCompliance — in_production SLA levels
// ----------------------------------------------------------------

describe('checkSlaCompliance — in_production SLA levels', () => {
  it('returns level "ok" when 0 business days have elapsed', () => {
    const now = new Date();
    const order = makeOrder({ status: 'in_production' });

    const result = checkSlaCompliance(order, now);

    expect(result.level).toBe('ok');
    expect(result.businessDaysInProduction).toBe(0);
  });

  it('returns level "ok" when exactly 3 business days have elapsed', () => {
    const monday = new Date('2025-03-17T00:00:00Z');
    // 3 business days after Monday = Thursday end-of-day
    const thursdayEnd = new Date('2025-03-20T23:59:59Z');

    vi.setSystemTime(thursdayEnd);

    const order = makeOrder({ status: 'in_production' });
    const result = checkSlaCompliance(order, monday);

    vi.useRealTimers();

    // Tue(1) Wed(2) Thu(3) → 3 days → ok (> 3 triggers warning)
    expect(result.businessDaysInProduction).toBe(3);
    expect(result.level).toBe('ok');
  });

  it('returns level "warning" when 4 business days have elapsed', () => {
    const monday = new Date('2025-03-17T00:00:00Z');
    // +4 business days = Friday 2025-03-21 end-of-day
    const fridayEnd = new Date('2025-03-21T23:59:59Z');

    vi.setSystemTime(fridayEnd);

    const order = makeOrder({ status: 'in_production' });
    const result = checkSlaCompliance(order, monday);

    vi.useRealTimers();

    // Tue(1) Wed(2) Thu(3) Fri(4) → 4 days → warning
    expect(result.businessDaysInProduction).toBe(4);
    expect(result.level).toBe('warning');
  });

  it('returns level "warning" when exactly 5 business days have elapsed', () => {
    const monday = new Date('2025-03-17T00:00:00Z');
    // +5 business days = Monday 2025-03-24 end-of-day
    const nextMondayEnd = new Date('2025-03-24T23:59:59Z');

    vi.setSystemTime(nextMondayEnd);

    const order = makeOrder({ status: 'in_production' });
    const result = checkSlaCompliance(order, monday);

    vi.useRealTimers();

    // Tue(1) Wed(2) Thu(3) Fri(4) Mon(5) → 5 days → warning (> 5 triggers alert)
    expect(result.businessDaysInProduction).toBe(5);
    expect(result.level).toBe('warning');
  });

  it('returns level "alert" when 6 business days have elapsed', () => {
    const monday = new Date('2025-03-17T00:00:00Z');
    // +6 business days = Tuesday 2025-03-25 end-of-day
    const tuesdayEnd = new Date('2025-03-25T23:59:59Z');

    vi.setSystemTime(tuesdayEnd);

    const order = makeOrder({ status: 'in_production' });
    const result = checkSlaCompliance(order, monday);

    vi.useRealTimers();

    // Tue(1) Wed(2) Thu(3) Fri(4) Mon(5) Tue(6) → 6 days → alert
    expect(result.businessDaysInProduction).toBe(6);
    expect(result.level).toBe('alert');
  });

  it('includes the business day count in the message', () => {
    const now = new Date();
    const order = makeOrder({ status: 'in_production' });

    const result = checkSlaCompliance(order, now);

    expect(result.message).toContain(String(result.businessDaysInProduction));
  });

  it('falls back to order.createdAt when productionStartedAt is not provided', () => {
    const order = makeOrder({
      status: 'in_production',
      createdAt: new Date('2020-01-06T00:00:00Z'),
    });

    const result = checkSlaCompliance(order);

    expect(result.level).toBe('alert');
    expect(result.businessDaysInProduction).toBeGreaterThan(5);
  });
});

// ----------------------------------------------------------------
// 4. Business day counting — weekend skipping
// ----------------------------------------------------------------

describe('countBusinessDays — weekend skipping (via checkSlaCompliance)', () => {
  it('a Mon→Sat span counts exactly 4 business days', () => {
    const monday = new Date('2025-03-17T00:00:00Z');
    const saturday = new Date('2025-03-22T00:00:00Z');

    vi.setSystemTime(saturday);

    const order = makeOrder({ status: 'in_production' });
    const result = checkSlaCompliance(order, monday);

    vi.useRealTimers();

    // Mon start, cursor: Tue(1), Wed(2), Thu(3), Fri(4), Sat skipped (cursor=Sat, end=Sat → cursor < end is false)
    expect(result.businessDaysInProduction).toBe(4);
    expect(result.level).toBe('warning');
  });

  it('skips both Saturday and Sunday in a Mon→Tue span', () => {
    const firstMonday = new Date('2025-03-17T00:00:00Z');
    // Tuesday the following week — spans Mon through the weekend to Tue
    const nextTuesday = new Date('2025-03-25T00:00:00Z');

    vi.setSystemTime(nextTuesday);

    const order = makeOrder({ status: 'in_production' });
    const result = checkSlaCompliance(order, firstMonday);

    vi.useRealTimers();

    // cursor: Tue(1), Wed(2), Thu(3), Fri(4), Sat(skip), Sun(skip), Mon(5), cursor=Tue, Tue < Tue false → 5
    expect(result.businessDaysInProduction).toBe(5);
    expect(result.level).toBe('warning');
  });

  it('returns 0 when end is before or equal to start', () => {
    const later = new Date('2025-03-20T00:00:00Z');
    const earlier = new Date('2025-03-17T00:00:00Z');

    vi.setSystemTime(earlier);

    const order = makeOrder({ status: 'in_production' });
    const result = checkSlaCompliance(order, later);

    vi.useRealTimers();

    expect(result.businessDaysInProduction).toBe(0);
    expect(result.level).toBe('ok');
  });
});

// ----------------------------------------------------------------
// 5. loadFulfillmentState
// ----------------------------------------------------------------

describe('loadFulfillmentState', () => {
  beforeEach(() => {
    mockReadFile.mockReset();
  });

  it('parses and returns state from the file when it exists', async () => {
    const stored: FulfillmentState = {
      lastRunAt: '2025-03-01T00:00:00.000Z',
      orderStates: {
        'order-001': {
          status: 'in_production',
          lastChecked: '2025-03-01T00:00:00.000Z',
          productionStartedAt: '2025-03-01T00:00:00.000Z',
        },
      },
    };

    mockReadFile.mockResolvedValueOnce(JSON.stringify(stored));

    const result = await loadFulfillmentState();

    expect(result.lastRunAt).toBe('2025-03-01T00:00:00.000Z');
    expect(result.orderStates['order-001']?.status).toBe('in_production');
  });

  it('returns a blank state when the file does not exist (ENOENT)', async () => {
    const enoentError = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    mockReadFile.mockRejectedValueOnce(enoentError);

    const result = await loadFulfillmentState();

    expect(result.orderStates).toEqual({});
    expect(result.lastRunAt).toBe(new Date(0).toISOString());
  });

  it('throws FulfillmentError on unexpected read failures', async () => {
    mockReadFile.mockRejectedValueOnce(new Error('Permission denied'));

    await expect(loadFulfillmentState()).rejects.toThrow(FulfillmentError);
  });

  it('throws FulfillmentError with a descriptive message on read failure', async () => {
    mockReadFile.mockRejectedValueOnce(new Error('disk full'));

    await expect(loadFulfillmentState()).rejects.toThrow('disk full');
  });
});

// ----------------------------------------------------------------
// 6. saveFulfillmentState
// ----------------------------------------------------------------

describe('saveFulfillmentState', () => {
  beforeEach(() => {
    mockWriteFile.mockReset();
    mockMkdir.mockReset();
  });

  it('creates the state directory with recursive: true', async () => {
    mockMkdir.mockResolvedValueOnce(undefined);
    mockWriteFile.mockResolvedValueOnce(undefined);

    const state: FulfillmentState = {
      lastRunAt: new Date().toISOString(),
      orderStates: {},
    };

    await saveFulfillmentState(state);

    expect(mockMkdir).toHaveBeenCalledOnce();
    const mkdirCall = mockMkdir.mock.calls[0];
    expect((mkdirCall?.[1] as Record<string, unknown>)['recursive']).toBe(true);
  });

  it('writes the serialised state as UTF-8 JSON', async () => {
    mockMkdir.mockResolvedValueOnce(undefined);
    mockWriteFile.mockResolvedValueOnce(undefined);

    const state: FulfillmentState = {
      lastRunAt: '2025-03-15T12:00:00.000Z',
      orderStates: {},
    };

    await saveFulfillmentState(state);

    const writeCall = mockWriteFile.mock.calls[0];
    const writtenContent = writeCall?.[1] as string;
    const writtenEncoding = writeCall?.[2] as string;

    expect(writtenEncoding).toBe('utf-8');
    const parsed = JSON.parse(writtenContent) as FulfillmentState;
    expect(parsed.lastRunAt).toBe('2025-03-15T12:00:00.000Z');
  });

  it('throws FulfillmentError when writeFile fails', async () => {
    mockMkdir.mockResolvedValueOnce(undefined);
    mockWriteFile.mockRejectedValueOnce(new Error('EACCES: permission denied'));

    const state: FulfillmentState = { lastRunAt: new Date().toISOString(), orderStates: {} };

    await expect(saveFulfillmentState(state)).rejects.toThrow(FulfillmentError);
  });

  it('throws FulfillmentError when mkdir fails', async () => {
    mockMkdir.mockRejectedValueOnce(new Error('ENOSPC: no space left'));

    const state: FulfillmentState = { lastRunAt: new Date().toISOString(), orderStates: {} };

    await expect(saveFulfillmentState(state)).rejects.toThrow(FulfillmentError);
  });
});
