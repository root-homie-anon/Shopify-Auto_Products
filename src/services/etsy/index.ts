// ============================================================
// Etsy Service
// Manages Etsy marketplace listings for the Banyakob apparel brand,
// synced from Shopify. All functions are pure/functional — the client
// object carries auth credentials but no mutable state.
// ============================================================

import { createLogger } from '../../utils/logger.js';
import { EtsyError } from '../../utils/errors.js';

import type {
  AppConfig,
  Listing,
  ListingCopy,
  ListingStatus,
  Product,
  ProductStatus,
} from '../../types/index.js';

// ----------------------------------------------------------------
// Local types
// ----------------------------------------------------------------

export interface EtsyClient {
  readonly apiKey: string;
  readonly accessToken: string;
  readonly shopId: string;
  readonly baseUrl: string;
}

/**
 * Etsy v3 listing state values as documented in the Etsy Open API v3 spec.
 */
export type EtsyListingState =
  | 'active'
  | 'inactive'
  | 'draft'
  | 'expired'
  | 'sold_out';

/**
 * Minimal shape of a listing object returned by the Etsy v3 API.
 * Only fields consumed downstream are typed explicitly; the rest are
 * captured as unknown to avoid false safety from partial knowledge.
 */
export interface EtsyListingResponse {
  readonly listing_id: number;
  readonly title: string;
  readonly description: string;
  readonly price: {
    readonly amount: number;
    readonly divisor: number;
    readonly currency_code: string;
  };
  readonly tags: readonly string[];
  readonly state: EtsyListingState;
  readonly url: string;
  readonly images: readonly EtsyListingImage[];
}

interface EtsyListingImage {
  readonly listing_image_id: number;
  readonly url_fullxfull: string;
  readonly rank: number;
}

/**
 * Payload shape sent to POST /application/shops/{shop_id}/listings.
 * Fields are named to match the Etsy v3 API docs verbatim.
 */
interface EtsyCreateListingPayload {
  readonly title: string;
  readonly description: string;
  readonly price: number;
  readonly quantity: number;
  readonly who_made: 'i_did' | 'someone_else' | 'collective';
  readonly when_made: string;
  readonly is_supply: boolean;
  readonly taxonomy_id: number;
  readonly tags: readonly string[];
  readonly state: EtsyListingState;
}

/**
 * Payload shape sent to PUT /application/shops/{shop_id}/listings/{listing_id}.
 */
interface EtsyUpdateListingPayload {
  readonly title?: string;
  readonly description?: string;
  readonly price?: number;
  readonly tags?: readonly string[];
  readonly state?: EtsyListingState;
}

// ----------------------------------------------------------------
// Constants
// ----------------------------------------------------------------

/**
 * Etsy taxonomy node ID for Clothing > Shirts & Tops.
 * Reference: https://www.etsy.com/taxonomy/v2
 */
const ETSY_TAXONOMY_ID_SHIRTS = 68887420;

/**
 * Etsy enforces a maximum of 13 tags per listing.
 */
const ETSY_MAX_TAGS = 13;

// ----------------------------------------------------------------
// Module-level logger
// ----------------------------------------------------------------

const logger = createLogger('etsy-service');

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------

/**
 * Maps our internal ProductStatus to the closest Etsy listing state.
 * Etsy does not have an 'archived' state — archived products are set
 * to 'inactive' so they stop appearing in search without being deleted.
 */
function toEtsyState(status: ProductStatus): EtsyListingState {
  switch (status) {
    case 'active':
      return 'active';
    case 'draft':
      return 'draft';
    case 'archived':
      return 'inactive';
  }
}

/**
 * Extracts the base price from the product's variant list. Uses the
 * lowest variant price so the listing price is never understated.
 * Throws EtsyError if the product has no variants.
 */
function resolveBasePrice(product: Product): number {
  if (product.variants.length === 0) {
    throw new EtsyError(
      `resolveBasePrice: product ${product.id} has no variants`,
    );
  }

  return product.variants.reduce(
    (min, v) => (v.price < min ? v.price : min),
    Number.POSITIVE_INFINITY,
  );
}

/**
 * Normalises an unknown thrown value into a descriptive EtsyError.
 */
function toEtsyError(context: string, cause: unknown): EtsyError {
  const message =
    cause instanceof Error
      ? `${context}: ${cause.message}`
      : `${context}: unknown error`;
  return new EtsyError(message);
}

/**
 * Appends query parameters to a URL string. Returns the original URL
 * unchanged if params is empty or undefined.
 */
function appendParams(
  url: string,
  params?: Record<string, string>,
): string {
  if (params === undefined || Object.keys(params).length === 0) {
    return url;
  }
  const qs = new URLSearchParams(params).toString();
  return `${url}?${qs}`;
}

// ----------------------------------------------------------------
// 1. createEtsyClient
// ----------------------------------------------------------------

/**
 * Returns an immutable client descriptor carrying the auth credentials
 * and base URL needed by every API call. No network activity occurs here.
 */
export function createEtsyClient(config: AppConfig['etsy']): EtsyClient {
  logger.info({ shopId: config.shopId }, 'Initialising Etsy client');
  return {
    apiKey: config.apiKey,
    accessToken: config.accessToken,
    shopId: config.shopId,
    baseUrl: 'https://api.etsy.com/v3',
  };
}

// ----------------------------------------------------------------
// 2. etsyFetch
// ----------------------------------------------------------------

/**
 * Generic authenticated fetch wrapper for the Etsy v3 REST API.
 *
 * Auth model (per Etsy docs):
 *   - x-api-key header carries the OAuth application key.
 *   - Authorization: Bearer carries the per-shop OAuth access token.
 *
 * Throws EtsyError for any non-2xx response, including the raw Etsy
 * error message from the response body when available.
 */
export async function etsyFetch<T>(
  client: EtsyClient,
  endpoint: string,
  options?: {
    method?: string;
    body?: unknown;
    params?: Record<string, string>;
  },
): Promise<T> {
  const method = options?.method ?? 'GET';
  const url = appendParams(`${client.baseUrl}${endpoint}`, options?.params);

  logger.info({ method, url }, 'Etsy API call');

  const headers: Record<string, string> = {
    'x-api-key': client.apiKey,
    'Authorization': `Bearer ${client.accessToken}`,
  };

  let fetchBody: string | undefined;

  if (options?.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    fetchBody = JSON.stringify(options.body);
  }

  let response: Response;

  try {
    response = await fetch(url, {
      method,
      headers,
      body: fetchBody,
    });
  } catch (err) {
    logger.error({ method, url, err }, 'Etsy network error');
    throw toEtsyError(`etsyFetch ${method} ${endpoint}`, err);
  }

  if (!response.ok) {
    let detail = `HTTP ${String(response.status)}`;
    try {
      const body = await response.json() as { error?: string; error_description?: string };
      const msg = body.error_description ?? body.error;
      if (msg !== undefined) detail += ` — ${msg}`;
    } catch {
      // response body is not JSON — keep the HTTP status detail only
    }
    logger.error({ method, url, status: response.status, detail }, 'Etsy API error response');
    throw new EtsyError(`etsyFetch ${method} ${endpoint}: ${detail}`);
  }

  // 204 No Content — return an empty object cast to T
  if (response.status === 204) {
    return {} as T;
  }

  try {
    return (await response.json()) as T;
  } catch (err) {
    throw toEtsyError(`etsyFetch ${method} ${endpoint} — JSON parse`, err);
  }
}

// ----------------------------------------------------------------
// 3. createListing
// ----------------------------------------------------------------

/**
 * Creates a new Etsy listing from our Product and ListingCopy types.
 *
 * Tag handling: Etsy allows a maximum of 13 tags. If the combined tag
 * list exceeds this limit the array is sliced — earliest tags take
 * precedence as they are assumed to be most relevant.
 *
 * Returns the Etsy listing ID as a string.
 */
export async function createListing(
  client: EtsyClient,
  product: Product,
  copy: ListingCopy,
): Promise<string> {
  logger.info(
    { productId: product.id, title: copy.title },
    'Creating Etsy listing',
  );

  const tags = [...copy.tags].slice(0, ETSY_MAX_TAGS);
  const basePrice = resolveBasePrice(product);

  const payload: EtsyCreateListingPayload = {
    title: copy.title,
    description: copy.description,
    price: basePrice,
    quantity: 999,
    who_made: 'someone_else',
    when_made: 'made_to_order',
    is_supply: false,
    taxonomy_id: ETSY_TAXONOMY_ID_SHIRTS,
    tags,
    state: toEtsyState(product.status),
  };

  const result = await etsyFetch<EtsyListingResponse>(
    client,
    `/application/shops/${client.shopId}/listings`,
    { method: 'POST', body: payload },
  );

  const listingId = String(result.listing_id);

  logger.info(
    { productId: product.id, etsyListingId: listingId },
    'Etsy listing created',
  );

  return listingId;
}

// ----------------------------------------------------------------
// 4. updateListing
// ----------------------------------------------------------------

/**
 * Applies a partial update to an existing Etsy listing.
 *
 * Accepts a subset of ListingCopy fields plus an optional status field
 * that maps through our ProductStatus → EtsyListingState translation.
 */
export async function updateListing(
  client: EtsyClient,
  listingId: string,
  updates: Partial<ListingCopy> & { status?: ProductStatus },
): Promise<EtsyListingResponse> {
  logger.info({ listingId }, 'Updating Etsy listing');

  const payload: EtsyUpdateListingPayload = {
    ...(updates.title !== undefined && { title: updates.title }),
    ...(updates.description !== undefined && { description: updates.description }),
    ...(updates.tags !== undefined && {
      tags: [...updates.tags].slice(0, ETSY_MAX_TAGS),
    }),
    ...(updates.status !== undefined && { state: toEtsyState(updates.status) }),
  };

  const result = await etsyFetch<EtsyListingResponse>(
    client,
    `/application/shops/${client.shopId}/listings/${listingId}`,
    { method: 'PUT', body: payload },
  );

  logger.info({ listingId }, 'Etsy listing updated');

  return result;
}

// ----------------------------------------------------------------
// 5. getListing
// ----------------------------------------------------------------

/**
 * Fetches a single Etsy listing by its listing ID.
 * Includes images in the response via the `includes` query param.
 */
export async function getListing(
  client: EtsyClient,
  listingId: string,
): Promise<EtsyListingResponse> {
  logger.info({ listingId }, 'Fetching Etsy listing');

  const result = await etsyFetch<EtsyListingResponse>(
    client,
    `/application/listings/${listingId}`,
    { params: { includes: 'images' } },
  );

  logger.info({ listingId }, 'Etsy listing fetched');

  return result;
}

// ----------------------------------------------------------------
// 6. uploadListingImage
// ----------------------------------------------------------------

/**
 * Uploads an image to an Etsy listing from a remote URL.
 *
 * Process:
 *  1. Download the image bytes from imageUrl using fetch.
 *  2. POST to Etsy's listing image endpoint as multipart/form-data.
 *
 * The `rank` parameter controls display order (1-based). Defaults to 1.
 *
 * Uses the native FormData and Blob APIs available in Node >=20.
 */
export async function uploadListingImage(
  client: EtsyClient,
  listingId: string,
  imageUrl: string,
  rank: number = 1,
): Promise<void> {
  logger.info({ listingId, imageUrl, rank }, 'Uploading image to Etsy listing');

  // Step 1 — download the image
  let imageResponse: Response;

  try {
    imageResponse = await fetch(imageUrl);
  } catch (err) {
    throw toEtsyError(
      `uploadListingImage: failed to download image from ${imageUrl}`,
      err,
    );
  }

  if (!imageResponse.ok) {
    throw new EtsyError(
      `uploadListingImage: image download returned HTTP ${String(imageResponse.status)} for ${imageUrl}`,
    );
  }

  let imageBuffer: ArrayBuffer;

  try {
    imageBuffer = await imageResponse.arrayBuffer();
  } catch (err) {
    throw toEtsyError(
      `uploadListingImage: failed to read image body from ${imageUrl}`,
      err,
    );
  }

  // Derive a Content-Type from the response or fall back to JPEG
  const contentType =
    imageResponse.headers.get('content-type') ?? 'image/jpeg';

  // Derive a filename from the URL path for the multipart field name
  const urlPath = new URL(imageUrl).pathname;
  const filename = urlPath.split('/').at(-1) ?? 'image.jpg';

  // Step 2 — build multipart form and POST to Etsy
  const form = new FormData();
  form.append(
    'image',
    new Blob([imageBuffer], { type: contentType }),
    filename,
  );
  form.append('rank', String(rank));

  const endpoint = `/application/shops/${client.shopId}/listings/${listingId}/images`;
  const url = `${client.baseUrl}${endpoint}`;

  logger.info({ listingId, endpoint, rank }, 'Posting image to Etsy');

  let uploadResponse: Response;

  try {
    uploadResponse = await fetch(url, {
      method: 'POST',
      headers: {
        'x-api-key': client.apiKey,
        'Authorization': `Bearer ${client.accessToken}`,
        // Do NOT set Content-Type manually — fetch sets it automatically
        // with the correct boundary when body is FormData.
      },
      body: form,
    });
  } catch (err) {
    logger.error({ listingId, err }, 'Etsy image upload network error');
    throw toEtsyError(`uploadListingImage(${listingId})`, err);
  }

  if (!uploadResponse.ok) {
    let detail = `HTTP ${String(uploadResponse.status)}`;
    try {
      const body = await uploadResponse.json() as { error?: string; error_description?: string };
      const msg = body.error_description ?? body.error;
      if (msg !== undefined) detail += ` — ${msg}`;
    } catch {
      // non-JSON body — keep status detail only
    }
    logger.error(
      { listingId, imageUrl, status: uploadResponse.status, detail },
      'Etsy image upload failed',
    );
    throw new EtsyError(`uploadListingImage(${listingId}): ${detail}`);
  }

  logger.info({ listingId, rank }, 'Etsy listing image uploaded');
}

// ----------------------------------------------------------------
// 7. syncFromShopify
// ----------------------------------------------------------------

/**
 * High-level sync function — creates or updates an Etsy listing to
 * reflect the current state of a Shopify product.
 *
 * Decision logic:
 *   - product.etsyListingId is null  → createListing, then upload images
 *   - product.etsyListingId is set   → updateListing, then upload images
 *
 * Images are always re-uploaded on sync so the Etsy listing stays in
 * step with design changes. The front image is rank 1; the back image
 * (when present) is rank 2.
 *
 * Returns a Listing domain object reflecting the outcome.
 */
export async function syncFromShopify(
  client: EtsyClient,
  product: Product,
  copy: ListingCopy,
): Promise<Listing> {
  logger.info(
    {
      productId: product.id,
      etsyListingId: product.etsyListingId,
    },
    'Syncing product to Etsy',
  );

  let listingId: string;
  let status: ListingStatus;
  let publishedAt: Date | null;
  let errorMessage: string | null = null;

  try {
    if (product.etsyListingId === null) {
      listingId = await createListing(client, product, copy);
    } else {
      listingId = product.etsyListingId;
      await updateListing(client, listingId, {
        title: copy.title,
        description: copy.description,
        tags: copy.tags,
        status: product.status,
      });
    }

    // Upload design images — always overwrite so the listing stays current.
    // Front image is rank 1, back image (when present) is rank 2.
    await uploadListingImage(
      client,
      listingId,
      product.design.frontImageUrl,
      1,
    );

    if (product.design.backImageUrl !== null) {
      await uploadListingImage(
        client,
        listingId,
        product.design.backImageUrl,
        2,
      );
    }

    status = 'published';
    publishedAt = new Date();

    logger.info(
      { productId: product.id, etsyListingId: listingId },
      'Etsy sync complete',
    );
  } catch (err) {
    // Surface the error as a failed Listing rather than propagating — the
    // caller can inspect errorMessage and decide on retry strategy.
    const message =
      err instanceof Error ? err.message : 'Unknown error during Etsy sync';
    logger.error(
      { productId: product.id, err },
      'Etsy sync failed',
    );
    status = 'failed';
    publishedAt = null;
    errorMessage = message;

    // We need a listing ID for the returned object even on failure.
    // If the listing was never created we use an empty string as a sentinel.
    listingId = product.etsyListingId ?? '';
  }

  const listing: Listing = {
    id: listingId,
    productId: product.id,
    platform: 'etsy',
    copy,
    status,
    publishedAt,
    errorMessage,
  };

  return listing;
}

// ----------------------------------------------------------------
// 8. deleteListing
// ----------------------------------------------------------------

/**
 * Permanently deletes (archives) an Etsy listing by its listing ID.
 *
 * Etsy's DELETE endpoint removes the listing entirely. For soft
 * de-listing (hiding from search without deletion) use updateListing
 * with status: 'archived' to transition to 'inactive' instead.
 */
export async function deleteListing(
  client: EtsyClient,
  listingId: string,
): Promise<void> {
  logger.info({ listingId }, 'Deleting Etsy listing');

  await etsyFetch<Record<string, never>>(
    client,
    `/application/shops/${client.shopId}/listings/${listingId}`,
    { method: 'DELETE' },
  );

  logger.info({ listingId }, 'Etsy listing deleted');
}
