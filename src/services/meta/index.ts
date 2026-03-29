// ============================================================
// Meta Ads Service
// Manages ad campaigns, creatives, and audiences via the Meta
// Marketing API (Graph API v19.0).
//
// PIPELINE INTEGRITY NOTICE:
//   All campaigns and ads are created in PAUSED status.
//   Human approval is required before any spend is activated.
//   activateAd() is the explicit approval gate — it must only
//   be called after a human has reviewed and signed off.
// ============================================================

import { createLogger } from '../../utils/logger.js';
import { MetaAdsError } from '../../utils/errors.js';

import type { AppConfig } from '../../types/index.js';

// ----------------------------------------------------------------
// Module-level logger
// ----------------------------------------------------------------

const logger = createLogger('meta-ads-service');

// ----------------------------------------------------------------
// Local types
// ----------------------------------------------------------------

export type CampaignObjective =
  | 'OUTCOME_SALES'
  | 'OUTCOME_TRAFFIC'
  | 'OUTCOME_AWARENESS'
  | 'OUTCOME_ENGAGEMENT';

export interface AdTargeting {
  readonly ageMin?: number;
  readonly ageMax?: number;
  readonly genders?: number[];
  readonly interests?: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  readonly locales?: string[];
  readonly countries?: string[];
}

export interface AdInsights {
  readonly impressions: number;
  readonly clicks: number;
  readonly spend: number;
  readonly conversions: number;
  readonly ctr: number;
  readonly cpc: number;
  readonly roas: number;
}

export interface MetaClient {
  readonly accessToken: string;
  readonly adAccountId: string;
  readonly baseUrl: string;
}

// ----------------------------------------------------------------
// Graph API response shapes
// ----------------------------------------------------------------

interface GraphApiError {
  readonly message: string;
  readonly type: string;
  readonly code: number;
  readonly fbtrace_id: string;
}

interface GraphApiErrorResponse {
  readonly error: GraphApiError;
}

interface CreateCampaignResponse {
  readonly id: string;
}

interface CreateAdSetResponse {
  readonly id: string;
}

interface CreateAdCreativeResponse {
  readonly id: string;
}

interface CreateAdResponse {
  readonly id: string;
}

interface UpdateAdStatusResponse {
  readonly success: boolean;
}

export interface CampaignStatusResponse {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly effective_status: string;
  readonly objective: string;
  readonly daily_budget: string;
  readonly created_time: string;
}

interface InsightRecord {
  readonly impressions: string;
  readonly clicks: string;
  readonly spend: string;
  readonly actions?: ReadonlyArray<{ readonly action_type: string; readonly value: string }>;
  readonly ctr: string;
  readonly cpc: string;
  readonly purchase_roas?: ReadonlyArray<{ readonly action_type: string; readonly value: string }>;
}

interface InsightsResponse {
  readonly data: InsightRecord[];
}

// ----------------------------------------------------------------
// Client factory
// ----------------------------------------------------------------

export function createMetaClient(config: AppConfig['meta']): MetaClient {
  return {
    accessToken: config.accessToken,
    adAccountId: config.adAccountId,
    baseUrl: 'https://graph.facebook.com/v19.0',
  };
}

// ----------------------------------------------------------------
// Generic fetch wrapper
// ----------------------------------------------------------------

export async function metaFetch<T>(
  client: MetaClient,
  endpoint: string,
  options?: {
    readonly method?: string;
    readonly body?: unknown;
    readonly params?: Record<string, string>;
  },
): Promise<T> {
  const method = options?.method ?? 'GET';
  const params = new URLSearchParams({
    access_token: client.accessToken,
    ...options?.params,
  });

  const url = `${client.baseUrl}${endpoint}?${params.toString()}`;

  logger.info({ method, endpoint }, 'Meta API call');

  const init: RequestInit = { method };

  if (options?.body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(options.body);
  }

  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (cause) {
    throw new MetaAdsError(
      `Network error calling Meta API ${endpoint}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new MetaAdsError(
      `Meta API ${endpoint} returned non-JSON response (status ${String(response.status)})`,
    );
  }

  if (!response.ok) {
    const errResponse = json as GraphApiErrorResponse;
    const detail = errResponse.error.message;
    throw new MetaAdsError(
      `Meta API error on ${endpoint}: ${detail} (code ${String(errResponse.error.code)})`,
    );
  }

  return json as T;
}

// ----------------------------------------------------------------
// Campaign
// ----------------------------------------------------------------

export async function createCampaign(
  client: MetaClient,
  params: {
    readonly name: string;
    readonly objective: CampaignObjective;
    readonly dailyBudget: number;
    readonly status?: 'PAUSED';
  },
): Promise<string> {
  // Status is always PAUSED — human must approve before any spend.
  const body = {
    name: params.name,
    objective: params.objective,
    daily_budget: String(Math.round(params.dailyBudget * 100)), // Graph API expects cents as a string
    status: 'PAUSED',
    special_ad_categories: [],
  };

  logger.info({ name: params.name, objective: params.objective }, 'Creating campaign (PAUSED)');

  const result = await metaFetch<CreateCampaignResponse>(
    client,
    `/act_${client.adAccountId}/campaigns`,
    { method: 'POST', body },
  );

  logger.info({ campaignId: result.id }, 'Campaign created');

  return result.id;
}

export async function getCampaignStatus(
  client: MetaClient,
  campaignId: string,
): Promise<CampaignStatusResponse> {
  logger.info({ campaignId }, 'Fetching campaign status');

  const result = await metaFetch<CampaignStatusResponse>(
    client,
    `/${campaignId}`,
    {
      params: {
        fields: 'id,name,status,effective_status,objective,daily_budget,created_time',
      },
    },
  );

  logger.info({ campaignId, status: result.status }, 'Campaign status fetched');

  return result;
}

// ----------------------------------------------------------------
// Ad Set
// ----------------------------------------------------------------

export async function createAdSet(
  client: MetaClient,
  params: {
    readonly campaignId: string;
    readonly name: string;
    readonly targeting: AdTargeting;
    readonly dailyBudget: number;
    readonly startTime?: Date;
  },
): Promise<string> {
  const targeting: Record<string, unknown> = {};

  if (params.targeting.ageMin !== undefined) {
    targeting['age_min'] = params.targeting.ageMin;
  }
  if (params.targeting.ageMax !== undefined) {
    targeting['age_max'] = params.targeting.ageMax;
  }
  if (params.targeting.genders !== undefined) {
    targeting['genders'] = params.targeting.genders;
  }
  if (params.targeting.interests !== undefined) {
    targeting['interests'] = params.targeting.interests;
  }
  if (params.targeting.locales !== undefined) {
    targeting['locales'] = params.targeting.locales;
  }
  if (params.targeting.countries !== undefined) {
    targeting['geo_locations'] = { countries: params.targeting.countries };
  }

  const body: Record<string, unknown> = {
    name: params.name,
    campaign_id: params.campaignId,
    daily_budget: String(Math.round(params.dailyBudget * 100)),
    billing_event: 'IMPRESSIONS',
    optimization_goal: 'OFFSITE_CONVERSIONS',
    targeting,
    status: 'PAUSED',
  };

  if (params.startTime !== undefined) {
    body['start_time'] = params.startTime.toISOString();
  }

  logger.info({ campaignId: params.campaignId, name: params.name }, 'Creating ad set (PAUSED)');

  const result = await metaFetch<CreateAdSetResponse>(
    client,
    `/act_${client.adAccountId}/adsets`,
    { method: 'POST', body },
  );

  logger.info({ adSetId: result.id }, 'Ad set created');

  return result.id;
}

// ----------------------------------------------------------------
// Ad Creative
// ----------------------------------------------------------------

export async function createAdCreative(
  client: MetaClient,
  creative: {
    readonly name: string;
    readonly imageUrl: string;
    readonly headline: string;
    readonly primaryText: string;
    readonly callToAction: string;
    readonly linkUrl: string;
  },
): Promise<string> {
  const body = {
    name: creative.name,
    object_story_spec: {
      page_id: client.adAccountId,
      link_data: {
        image_url: creative.imageUrl,
        link: creative.linkUrl,
        message: creative.primaryText,
        name: creative.headline,
        call_to_action: {
          type: creative.callToAction,
        },
      },
    },
  };

  logger.info({ name: creative.name }, 'Creating ad creative');

  const result = await metaFetch<CreateAdCreativeResponse>(
    client,
    `/act_${client.adAccountId}/adcreatives`,
    { method: 'POST', body },
  );

  logger.info({ creativeId: result.id }, 'Ad creative created');

  return result.id;
}

// ----------------------------------------------------------------
// Ad
// ----------------------------------------------------------------

export async function createAd(
  client: MetaClient,
  params: {
    readonly adSetId: string;
    readonly creativeId: string;
    readonly name: string;
    readonly status?: 'PAUSED';
  },
): Promise<string> {
  // Status is always PAUSED — human must approve before any spend.
  const body = {
    name: params.name,
    adset_id: params.adSetId,
    creative: { creative_id: params.creativeId },
    status: 'PAUSED',
  };

  logger.info(
    { adSetId: params.adSetId, creativeId: params.creativeId, name: params.name },
    'Creating ad (PAUSED)',
  );

  const result = await metaFetch<CreateAdResponse>(
    client,
    `/act_${client.adAccountId}/ads`,
    { method: 'POST', body },
  );

  logger.info({ adId: result.id }, 'Ad created');

  return result.id;
}

// ----------------------------------------------------------------
// Ad status management
// ----------------------------------------------------------------

export async function pauseAd(client: MetaClient, adId: string): Promise<void> {
  logger.info({ adId }, 'Pausing ad');

  await metaFetch<UpdateAdStatusResponse>(
    client,
    `/${adId}`,
    { method: 'POST', body: { status: 'PAUSED' } },
  );

  logger.info({ adId }, 'Ad paused');
}

export async function activateAd(client: MetaClient, adId: string): Promise<void> {
  // This is the human-approval gate. Only call this after explicit human sign-off.
  logger.info({ adId }, 'Activating ad (human-approved)');

  await metaFetch<UpdateAdStatusResponse>(
    client,
    `/${adId}`,
    { method: 'POST', body: { status: 'ACTIVE' } },
  );

  logger.info({ adId }, 'Ad activated');
}

// ----------------------------------------------------------------
// Performance insights
// ----------------------------------------------------------------

export async function getAdPerformance(
  client: MetaClient,
  adId: string,
  dateRange?: { readonly since: string; readonly until: string },
): Promise<AdInsights> {
  const params: Record<string, string> = {
    fields: 'impressions,clicks,spend,actions,ctr,cpc,purchase_roas',
  };

  if (dateRange !== undefined) {
    params['time_range'] = JSON.stringify({ since: dateRange.since, until: dateRange.until });
  }

  logger.info({ adId, dateRange }, 'Fetching ad performance insights');

  const result = await metaFetch<InsightsResponse>(
    client,
    `/${adId}/insights`,
    { params },
  );

  if (result.data.length === 0) {
    logger.info({ adId }, 'No insight data returned — returning zero values');

    return {
      impressions: 0,
      clicks: 0,
      spend: 0,
      conversions: 0,
      ctr: 0,
      cpc: 0,
      roas: 0,
    };
  }

  const record = result.data[0];

  if (record === undefined) {
    throw new MetaAdsError(`Meta API returned empty insights data for ad ${adId}`);
  }

  const conversionValue =
    record.actions?.find((a) => a.action_type === 'purchase')?.value ?? '0';

  const roasValue =
    record.purchase_roas?.find((r) => r.action_type === 'omni_purchase')?.value ?? '0';

  return {
    impressions: parseInt(record.impressions, 10),
    clicks: parseInt(record.clicks, 10),
    spend: parseFloat(record.spend),
    conversions: parseFloat(conversionValue),
    ctr: parseFloat(record.ctr),
    cpc: parseFloat(record.cpc),
    roas: parseFloat(roasValue),
  };
}
