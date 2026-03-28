// ============================================================
// Content Service — Unit Tests
// Focus: parseJson (markdown fence stripping), SEO description
// truncation at 160 chars, and generateBatchListingCopy partial
// failure isolation.
// Anthropic SDK is mocked; internal helpers are exercised via
// public functions.
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Product, AppConfig } from '../../../types/index.js';
import { ContentError } from '../../../utils/errors.js';

// ----------------------------------------------------------------
// Hoist mocks so they are initialised before vi.mock() factories run
// ----------------------------------------------------------------

const { mockMessagesCreate, MockAnthropic } = vi.hoisted(() => {
  const mockMessagesCreate = vi.fn();
  const MockAnthropic = vi.fn().mockImplementation(() => ({
    messages: { create: mockMessagesCreate },
  }));
  return { mockMessagesCreate, MockAnthropic };
});

vi.mock('@anthropic-ai/sdk', () => ({ default: MockAnthropic }));

// Import after mock
import {
  createContentClient,
  generateListingCopy,
  generateBatchListingCopy,
} from '../index.js';

// ----------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------

const anthropicConfig: AppConfig['anthropic'] = {
  apiKey: 'sk-ant-test-123',
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
    variants: [],
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

/**
 * Builds a minimal Anthropic Message response wrapping a text block.
 */
function makeAnthropicResponse(text: string): object {
  return {
    id: 'msg-test',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text }],
    model: 'claude-sonnet-4-6',
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 20 },
  };
}

function makeValidListingJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    title: 'Archangel Michael Icon — Unisex T-Shirt | Banyakob',
    description: '<p>Sacred art on premium cotton.</p>',
    tags: ['christian apparel', 'byzantine art'],
    seoTitle: 'Archangel Michael Christian T-Shirt | Byzantine Art Streetwear | Banyakob',
    seoDescription: 'Faith-driven apparel by Banyakob. Christian streetwear.',
    ...overrides,
  });
}

// ----------------------------------------------------------------
// 1. createContentClient
// ----------------------------------------------------------------

describe('createContentClient', () => {
  it('constructs an Anthropic instance with the provided API key', () => {
    MockAnthropic.mockClear();

    createContentClient(anthropicConfig);

    expect(MockAnthropic).toHaveBeenCalledOnce();
    const callArgs = MockAnthropic.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(callArgs['apiKey']).toBe('sk-ant-test-123');
  });
});

// ----------------------------------------------------------------
// 2. parseJson — markdown fence stripping
// ----------------------------------------------------------------

describe('generateListingCopy — JSON parsing', () => {
  let client: ReturnType<typeof createContentClient>;

  beforeEach(() => {
    client = createContentClient(anthropicConfig);
    mockMessagesCreate.mockReset();
  });

  it('parses bare JSON without markdown fences', async () => {
    const bareJson = makeValidListingJson();
    mockMessagesCreate.mockResolvedValueOnce(makeAnthropicResponse(bareJson));

    const result = await generateListingCopy(client, makeProduct());

    expect(result.title).toBe('Archangel Michael Icon — Unisex T-Shirt | Banyakob');
  });

  it('strips ```json ... ``` fences before parsing', async () => {
    const fencedJson = '```json\n' + makeValidListingJson() + '\n```';
    mockMessagesCreate.mockResolvedValueOnce(makeAnthropicResponse(fencedJson));

    const result = await generateListingCopy(client, makeProduct());

    expect(result.description).toBe('<p>Sacred art on premium cotton.</p>');
  });

  it('strips ``` ... ``` fences (no language specifier) before parsing', async () => {
    const fencedJson = '```\n' + makeValidListingJson() + '\n```';
    mockMessagesCreate.mockResolvedValueOnce(makeAnthropicResponse(fencedJson));

    const result = await generateListingCopy(client, makeProduct());

    expect(result.tags).toEqual(['christian apparel', 'byzantine art']);
  });

  it('throws ContentError when response contains non-JSON text', async () => {
    mockMessagesCreate.mockResolvedValueOnce(
      makeAnthropicResponse('Sorry, I cannot generate that content right now.'),
    );

    await expect(generateListingCopy(client, makeProduct())).rejects.toThrow(ContentError);
  });

  it('throws ContentError when response has no text block', async () => {
    const responseWithNoText = {
      id: 'msg-test',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'tool-1', name: 'some_tool', input: {} }],
      model: 'claude-sonnet-4-6',
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    };

    mockMessagesCreate.mockResolvedValueOnce(responseWithNoText);

    await expect(generateListingCopy(client, makeProduct())).rejects.toThrow(ContentError);
  });

  it('throws ContentError when a required field is missing from parsed JSON', async () => {
    const missingTitle = makeValidListingJson({ title: '' });
    mockMessagesCreate.mockResolvedValueOnce(makeAnthropicResponse(missingTitle));

    await expect(generateListingCopy(client, makeProduct())).rejects.toThrow(ContentError);
  });

  it('throws ContentError when tags field is not an array', async () => {
    const badTags = makeValidListingJson({ tags: 'christian apparel' });
    mockMessagesCreate.mockResolvedValueOnce(makeAnthropicResponse(badTags));

    await expect(generateListingCopy(client, makeProduct())).rejects.toThrow(ContentError);
  });
});

// ----------------------------------------------------------------
// 3. SEO description truncation
// ----------------------------------------------------------------

describe('generateListingCopy — SEO description truncation', () => {
  let client: ReturnType<typeof createContentClient>;

  beforeEach(() => {
    client = createContentClient(anthropicConfig);
    mockMessagesCreate.mockReset();
  });

  it('preserves seoDescription unchanged when it is exactly 160 chars', async () => {
    const exactly160 = 'A'.repeat(160);
    mockMessagesCreate.mockResolvedValueOnce(
      makeAnthropicResponse(makeValidListingJson({ seoDescription: exactly160 })),
    );

    const result = await generateListingCopy(client, makeProduct());

    expect(result.seoDescription).toBe(exactly160);
    expect(result.seoDescription.length).toBe(160);
  });

  it('preserves seoDescription unchanged when it is under 160 chars', async () => {
    const short = 'Short SEO desc.';
    mockMessagesCreate.mockResolvedValueOnce(
      makeAnthropicResponse(makeValidListingJson({ seoDescription: short })),
    );

    const result = await generateListingCopy(client, makeProduct());

    expect(result.seoDescription).toBe('Short SEO desc.');
  });

  it('truncates seoDescription to 160 chars when it exceeds 160 chars', async () => {
    const tooLong = 'B'.repeat(200);
    mockMessagesCreate.mockResolvedValueOnce(
      makeAnthropicResponse(makeValidListingJson({ seoDescription: tooLong })),
    );

    const result = await generateListingCopy(client, makeProduct());

    expect(result.seoDescription.length).toBe(160);
  });

  it('appends "..." when truncating at 157 chars', async () => {
    const tooLong = 'C'.repeat(200);
    mockMessagesCreate.mockResolvedValueOnce(
      makeAnthropicResponse(makeValidListingJson({ seoDescription: tooLong })),
    );

    const result = await generateListingCopy(client, makeProduct());

    expect(result.seoDescription.endsWith('...')).toBe(true);
    expect(result.seoDescription.slice(0, 157)).toBe('C'.repeat(157));
  });

  it('truncates at exactly 161 chars to produce a 160-char result', async () => {
    const justOver = 'D'.repeat(161);
    mockMessagesCreate.mockResolvedValueOnce(
      makeAnthropicResponse(makeValidListingJson({ seoDescription: justOver })),
    );

    const result = await generateListingCopy(client, makeProduct());

    expect(result.seoDescription.length).toBe(160);
    expect(result.seoDescription.endsWith('...')).toBe(true);
  });
});

// ----------------------------------------------------------------
// 4. generateBatchListingCopy — partial failure isolation
// ----------------------------------------------------------------

describe('generateBatchListingCopy — partial failures', () => {
  let client: ReturnType<typeof createContentClient>;

  beforeEach(() => {
    client = createContentClient(anthropicConfig);
    mockMessagesCreate.mockReset();
  });

  it('returns results only for products that succeed', async () => {
    const prod1 = makeProduct({ id: 'prod-1' });
    const prod2 = makeProduct({ id: 'prod-2' });

    // prod-1 succeeds
    mockMessagesCreate.mockResolvedValueOnce(
      makeAnthropicResponse(makeValidListingJson()),
    );
    // prod-2 fails
    mockMessagesCreate.mockRejectedValueOnce(new Error('API error'));

    const results = await generateBatchListingCopy(client, [prod1, prod2]);

    expect(results.size).toBe(1);
    expect(results.has('prod-1')).toBe(true);
    expect(results.has('prod-2')).toBe(false);
  });

  it('returns an empty Map when all products fail', async () => {
    const prod1 = makeProduct({ id: 'prod-1' });
    const prod2 = makeProduct({ id: 'prod-2' });

    mockMessagesCreate.mockRejectedValue(new Error('always fails'));

    const results = await generateBatchListingCopy(client, [prod1, prod2]);

    expect(results.size).toBe(0);
  });

  it('processes all products and does not abort on a single failure', async () => {
    const products = [
      makeProduct({ id: 'p-1' }),
      makeProduct({ id: 'p-2' }),
      makeProduct({ id: 'p-3' }),
    ];

    // p-1 fails, p-2 succeeds, p-3 succeeds
    mockMessagesCreate
      .mockRejectedValueOnce(new Error('fail p-1'))
      .mockResolvedValueOnce(makeAnthropicResponse(makeValidListingJson({ title: 'Title P2' })))
      .mockResolvedValueOnce(makeAnthropicResponse(makeValidListingJson({ title: 'Title P3' })));

    const results = await generateBatchListingCopy(client, products);

    expect(results.size).toBe(2);
    expect(results.has('p-1')).toBe(false);
    expect(results.get('p-2')?.title).toBe('Title P2');
    expect(results.get('p-3')?.title).toBe('Title P3');
  });

  it('returns a Map keyed by product ID', async () => {
    const prod = makeProduct({ id: 'unique-id-456' });
    mockMessagesCreate.mockResolvedValueOnce(
      makeAnthropicResponse(makeValidListingJson()),
    );

    const results = await generateBatchListingCopy(client, [prod]);

    expect(results.has('unique-id-456')).toBe(true);
  });

  it('returns an empty Map when given an empty product list', async () => {
    const results = await generateBatchListingCopy(client, []);

    expect(results.size).toBe(0);
    expect(mockMessagesCreate).not.toHaveBeenCalled();
  });

  it('does not swallow ContentErrors — they are caught and product is skipped', async () => {
    const prod1 = makeProduct({ id: 'p-content-error' });
    const prod2 = makeProduct({ id: 'p-ok' });

    mockMessagesCreate
      .mockResolvedValueOnce(makeAnthropicResponse('not json at all'))
      .mockResolvedValueOnce(makeAnthropicResponse(makeValidListingJson()));

    const results = await generateBatchListingCopy(client, [prod1, prod2]);

    expect(results.has('p-content-error')).toBe(false);
    expect(results.has('p-ok')).toBe(true);
  });
});
