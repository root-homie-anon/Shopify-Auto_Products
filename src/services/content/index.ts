// ============================================================
// Content Service
// Generates listing copy, social captions, and ad copy for
// the Banyakob Christian apparel brand via the Anthropic SDK.
// ============================================================

import Anthropic from '@anthropic-ai/sdk';

import { createLogger } from '../../utils/logger.js';
import { ContentError } from '../../utils/errors.js';

import type {
  AppConfig,
  Product,
  ListingCopy,
  ContentPlatform,
} from '../../types/index.js';

// ----------------------------------------------------------------
// Local types
// ----------------------------------------------------------------

export interface AdCopyResult {
  readonly headline: string;
  readonly primaryText: string;
  readonly callToAction: string;
}

// Raw shapes expected from Claude JSON responses — validated at
// parse time before being promoted to the exported domain types.
interface RawListingCopy {
  title: unknown;
  description: unknown;
  tags: unknown;
  seoTitle: unknown;
  seoDescription: unknown;
}

interface RawAdCopy {
  headline: unknown;
  primaryText: unknown;
  callToAction: unknown;
}

// ----------------------------------------------------------------
// Module-level logger
// ----------------------------------------------------------------

const logger = createLogger('content-service');

// ----------------------------------------------------------------
// Brand context — embedded inline so every prompt has full context
// without a file-system read at call time.
// ----------------------------------------------------------------

const BRAND_GUIDELINES = `
# Banyakob — Brand Guidelines

## Brand Name
Banyakob

## Niche
Christian lifestyle apparel

## Logo
Gold lion head — canonical, not subject to redesign.

## Aesthetic
Byzantine / Orthodox icon art meets urban streetwear.

Key visual elements:
- Gold tones
- Sacred geometry
- Iconographic linework
- Modern composition

## Tone of Voice
Elevated, cultural, faith-driven. This is not generic church merch. The brand speaks
with confidence and reverence — never preachy, never casual to the point of losing gravitas.

## Target Buyer
Faith-driven urban consumers across demographics. The buyer self-selects through aesthetic
resonance, not demographic targeting.

## Color Palette
- Primary: Gold / Antique Gold
- Secondary: Black, Deep Burgundy, Ivory
- Accent: Byzantine Blue, Burnt Sienna

## Product Blank
Bella+Canvas 3001 — premium feel, retail fit, wide color range.

## Print Method
DTG (direct to garment) — front and back.

## Do / Do Not
Do:
- Use iconographic and sacred art motifs
- Maintain premium feel in all touchpoints
- Let the art speak — minimal text on garments
- Use gold foil / metallic effects where the medium allows

Do Not:
- Use clip art or stock religious imagery
- Use overly literal Bible quotes as primary design elements
- Cheapen the aesthetic with discount-first messaging
- Use neon or high-saturation pop colors
`.trim();

const LISTING_TEMPLATE = `
# Banyakob — Listing Template

## Title Format
[Design Name] — [Product Type] | Banyakob

Example: Archangel Michael Icon — Unisex T-Shirt | Banyakob

## Description Structure

### Paragraph 1 — Hook
One sentence that connects the design to its spiritual or cultural meaning.
Elevated tone — not salesy.

### Paragraph 2 — Design Details
Describe the artwork: style, motifs, placement (front/back).
Reference the Byzantine/streetwear aesthetic.

### Paragraph 3 — Product Details
- Bella+Canvas 3001 unisex tee
- Retail fit, soft ringspun cotton
- DTG printed — front and back
- Pre-shrunk, side-seamed

### Paragraph 4 — Sizing and Care
- True to size — see size chart
- Machine wash cold, tumble dry low

### Paragraph 5 — Brand Close
One line about Banyakob — faith-driven apparel that honors sacred art traditions.

## Tags
Always include:
- christian apparel
- faith based clothing
- orthodox art
- byzantine art
- christian streetwear
- religious t-shirt
- banyakob

Add design-specific tags per product (saint name, motif, collection).

## SEO Title
[Design Name] Christian T-Shirt | Byzantine Art Streetwear | Banyakob

## SEO Description
Under 160 characters. Include: design name, "Christian apparel", "Banyakob".
`.trim();

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------

/**
 * Extracts the text content from a Claude API response.
 * Throws ContentError if the response contains no text block.
 */
function extractText(response: Anthropic.Message): string {
  const block = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
  if (block === undefined) {
    throw new ContentError(
      'Claude returned no text block — check the prompt or model response',
    );
  }
  return block.text;
}

/**
 * Parses a JSON string from Claude's response text.
 * Claude may wrap JSON in markdown fences; strips them if present.
 * Throws ContentError on invalid JSON so the caller always sees a
 * typed domain error, never a raw SyntaxError.
 */
function parseJson(raw: string, context: string): unknown {
  const stripped = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();

  try {
    return JSON.parse(stripped);
  } catch {
    throw new ContentError(
      `${context}: Claude returned non-JSON text — ${stripped.slice(0, 120)}`,
    );
  }
}

/**
 * Guards that a value is a non-empty string.
 */
function assertString(value: unknown, field: string, context: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ContentError(`${context}: missing or empty field "${field}"`);
  }
  return value.trim();
}

/**
 * Guards that a value is an array of non-empty strings.
 */
function assertStringArray(
  value: unknown,
  field: string,
  context: string,
): string[] {
  if (!Array.isArray(value)) {
    throw new ContentError(`${context}: field "${field}" must be an array`);
  }
  return value.map((item, i) => {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new ContentError(
        `${context}: field "${field}[${String(i)}]" must be a non-empty string`,
      );
    }
    return item.trim();
  });
}

/**
 * Converts an unknown thrown value into a ContentError with context.
 * If the thrown value is already a ContentError it is re-thrown as-is
 * so error messages don't get double-wrapped.
 */
function toContentError(context: string, cause: unknown): ContentError {
  if (cause instanceof ContentError) return cause;
  const message =
    cause instanceof Error
      ? `${context}: ${cause.message}`
      : `${context}: unknown error`;
  return new ContentError(message);
}

// ----------------------------------------------------------------
// 1. createContentClient
// ----------------------------------------------------------------

/**
 * Initialises and returns the Anthropic SDK client.
 */
export function createContentClient(
  config: AppConfig['anthropic'],
): Anthropic {
  logger.info('Initialising Anthropic content client');
  return new Anthropic({ apiKey: config.apiKey });
}

// ----------------------------------------------------------------
// 2. generateListingCopy
// ----------------------------------------------------------------

const LISTING_SYSTEM_PROMPT = `
You are a copywriter for Banyakob, a premium Christian lifestyle apparel brand.

${BRAND_GUIDELINES}

---

${LISTING_TEMPLATE}

---

When asked to generate a product listing, you must respond with a single JSON object
and nothing else. Do not wrap it in markdown fences. The object must conform exactly
to this shape:

{
  "title": "string — follows the [Design Name] — [Product Type] | Banyakob format",
  "description": "string — full HTML-safe multi-paragraph description following the template above",
  "tags": ["array", "of", "lowercase", "tag", "strings"],
  "seoTitle": "string — follows [Design Name] Christian T-Shirt | Byzantine Art Streetwear | Banyakob",
  "seoDescription": "string — under 160 characters, includes design name, Christian apparel, Banyakob"
}
`.trim();

/**
 * Generates a complete ListingCopy object for a product using brand
 * guidelines and the listing template as system context.
 *
 * Temperature 0.3 — listing copy benefits from consistency.
 */
export async function generateListingCopy(
  client: Anthropic,
  product: Product,
): Promise<ListingCopy> {
  logger.info(
    { productId: product.id, designName: product.design.name },
    'Generating listing copy',
  );

  const userPrompt = `
Generate a complete Shopify listing for this product:

Design name: ${product.design.name}
Product type: ${product.productType}
Vendor: ${product.vendor}
Existing tags: ${product.tags.join(', ')}

Respond with a single JSON object only.
`.trim();

  let response: Anthropic.Message;

  try {
    response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      temperature: 0.3,
      system: LISTING_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    });
  } catch (cause) {
    logger.error(
      { productId: product.id, cause },
      'Claude API call failed for listing copy',
    );
    throw toContentError(`generateListingCopy(${product.id})`, cause);
  }

  const raw = extractText(response);
  const ctx = `generateListingCopy(${product.id})`;
  const parsed = parseJson(raw, ctx) as RawListingCopy;

  const listing: ListingCopy = {
    title: assertString(parsed.title, 'title', ctx),
    description: assertString(parsed.description, 'description', ctx),
    tags: assertStringArray(parsed.tags, 'tags', ctx),
    seoTitle: assertString(parsed.seoTitle, 'seoTitle', ctx),
    seoDescription: assertString(parsed.seoDescription, 'seoDescription', ctx),
  };

  // Enforce the 160-char SEO description limit — truncate rather than fail
  // so the pipeline is not blocked by a single character overshoot.
  const safeSeoDescription =
    listing.seoDescription.length > 160
      ? listing.seoDescription.slice(0, 157) + '...'
      : listing.seoDescription;

  const result: ListingCopy = { ...listing, seoDescription: safeSeoDescription };

  logger.info(
    { productId: product.id, title: result.title },
    'Listing copy generated',
  );

  return result;
}

// ----------------------------------------------------------------
// 3. generateSocialCaption
// ----------------------------------------------------------------

const SOCIAL_SYSTEM_PROMPT = `
You are a social media strategist for Banyakob, a premium Christian lifestyle apparel brand.

${BRAND_GUIDELINES}

---

Platform guidelines:

TIKTOK: Short, punchy, culturally resonant. Max 3 sentences. End with 5-8 tightly relevant
hashtags on a new line. No generic religious clichés — the brand has aesthetic gravity.

INSTAGRAM: Longer form, storytelling-forward. 3-5 sentences that draw the viewer in.
Elevated, editorial tone. End with 10-15 hashtags on a new line including both niche
faith tags and broader streetwear/fashion tags.

Respond with plain text only — the caption string, nothing else.
`.trim();

/**
 * Generates a platform-specific social media caption.
 *
 * Temperature 0.7 — social copy benefits from voice variety.
 */
export async function generateSocialCaption(
  client: Anthropic,
  product: Product,
  platform: ContentPlatform,
): Promise<string> {
  logger.info(
    { productId: product.id, platform },
    'Generating social caption',
  );

  const userPrompt = `
Write a ${platform.toUpperCase()} caption for this Banyakob product:

Design name: ${product.design.name}
Product type: ${product.productType}
Tags: ${product.tags.join(', ')}

Platform: ${platform}
`.trim();

  let response: Anthropic.Message;

  try {
    response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 512,
      temperature: 0.7,
      system: SOCIAL_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    });
  } catch (cause) {
    logger.error(
      { productId: product.id, platform, cause },
      'Claude API call failed for social caption',
    );
    throw toContentError(
      `generateSocialCaption(${product.id}, ${platform})`,
      cause,
    );
  }

  const caption = extractText(response).trim();

  if (caption.length === 0) {
    throw new ContentError(
      `generateSocialCaption(${product.id}, ${platform}): Claude returned an empty caption`,
    );
  }

  logger.info(
    { productId: product.id, platform, captionLength: caption.length },
    'Social caption generated',
  );

  return caption;
}

// ----------------------------------------------------------------
// 4. generateAdCopy
// ----------------------------------------------------------------

const AD_COPY_SYSTEM_PROMPT = `
You are a direct-response copywriter for Banyakob, a premium Christian lifestyle apparel brand.

${BRAND_GUIDELINES}

---

You write Meta (Facebook/Instagram) ad copy. The brand never uses discount-first messaging
or generic religious appeals. The copy should carry the weight of the brand — premium,
culturally resonant, faith-driven without being preachy.

When asked to generate ad copy, respond with a single JSON object and nothing else.
Do not wrap it in markdown fences. The object must conform to this exact shape:

{
  "headline": "string — short, attention-grabbing, under 40 characters",
  "primaryText": "string — 2-3 sentence persuasive copy, brand-aligned, no discount language",
  "callToAction": "string — one of: Shop Now, Learn More, Get Yours, Wear the Story"
}
`.trim();

/**
 * Generates ad creative copy (headline, primary text, call to action).
 *
 * Temperature 0.7 — ad copy benefits from creative variety.
 */
export async function generateAdCopy(
  client: Anthropic,
  product: Product,
): Promise<AdCopyResult> {
  logger.info(
    { productId: product.id, designName: product.design.name },
    'Generating ad copy',
  );

  const userPrompt = `
Generate Meta ad copy for this Banyakob product:

Design name: ${product.design.name}
Product type: ${product.productType}
Tags: ${product.tags.join(', ')}

Respond with a single JSON object only.
`.trim();

  let response: Anthropic.Message;

  try {
    response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 512,
      temperature: 0.7,
      system: AD_COPY_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    });
  } catch (cause) {
    logger.error(
      { productId: product.id, cause },
      'Claude API call failed for ad copy',
    );
    throw toContentError(`generateAdCopy(${product.id})`, cause);
  }

  const raw = extractText(response);
  const ctx = `generateAdCopy(${product.id})`;
  const parsed = parseJson(raw, ctx) as RawAdCopy;

  const result: AdCopyResult = {
    headline: assertString(parsed.headline, 'headline', ctx),
    primaryText: assertString(parsed.primaryText, 'primaryText', ctx),
    callToAction: assertString(parsed.callToAction, 'callToAction', ctx),
  };

  logger.info(
    { productId: product.id, headline: result.headline },
    'Ad copy generated',
  );

  return result;
}

// ----------------------------------------------------------------
// 5. generateBatchListingCopy
// ----------------------------------------------------------------

/**
 * Generates listing copy for multiple products sequentially.
 *
 * Sequential (not parallel) to respect Anthropic API rate limits.
 * Returns a Map keyed by product ID so the caller has O(1) lookup.
 *
 * On per-product failure the error is logged and the product is
 * skipped so a single bad product does not abort the batch. The
 * caller can detect skipped products by comparing Map size to the
 * input length.
 */
export async function generateBatchListingCopy(
  client: Anthropic,
  products: readonly Product[],
): Promise<Map<string, ListingCopy>> {
  logger.info({ count: products.length }, 'Starting batch listing copy generation');

  const results = new Map<string, ListingCopy>();

  for (const product of products) {
    try {
      const copy = await generateListingCopy(client, product);
      results.set(product.id, copy);
    } catch (cause) {
      // Log and skip — do not abort the batch for a single product failure.
      logger.error(
        { productId: product.id, cause },
        'Skipping product in batch — listing copy generation failed',
      );
    }
  }

  logger.info(
    { requested: products.length, generated: results.size },
    'Batch listing copy generation complete',
  );

  return results;
}
