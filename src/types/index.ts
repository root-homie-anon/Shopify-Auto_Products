// ============================================================
// Banyakob — Core Type Definitions
// ============================================================

// --- Product Domain ---

export interface PrintArea {
  readonly front: { width: number; height: number };
  readonly back: { width: number; height: number };
}

export interface ProductDesign {
  readonly id: string;
  readonly name: string;
  readonly frontImageUrl: string;
  readonly backImageUrl: string | null;
  readonly createdAt: Date;
  readonly approvedAt: Date | null;
}

export interface ProductVariant {
  readonly size: ProductSize;
  readonly color: string;
  readonly sku: string;
  readonly price: number;
  readonly compareAtPrice: number | null;
  readonly inventoryQuantity: number;
}

export type ProductSize = 'XS' | 'S' | 'M' | 'L' | 'XL' | '2XL' | '3XL';

export type ProductStatus = 'draft' | 'active' | 'archived';

export interface Product {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly design: ProductDesign;
  readonly variants: readonly ProductVariant[];
  readonly tags: readonly string[];
  readonly productType: string;
  readonly vendor: string;
  readonly status: ProductStatus;
  readonly shopifyId: string | null;
  readonly etsyListingId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

// --- Listing Domain ---

export interface ListingCopy {
  readonly title: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly seoTitle: string;
  readonly seoDescription: string;
}

export type ListingPlatform = 'shopify' | 'etsy';

export type ListingStatus = 'pending' | 'published' | 'failed';

export interface Listing {
  readonly id: string;
  readonly productId: string;
  readonly platform: ListingPlatform;
  readonly copy: ListingCopy;
  readonly status: ListingStatus;
  readonly publishedAt: Date | null;
  readonly errorMessage: string | null;
}

// --- Order / Fulfillment Domain ---

export type OrderStatus =
  | 'received'
  | 'sent_to_fulfillment'
  | 'in_production'
  | 'shipped'
  | 'delivered'
  | 'cancelled'
  | 'error';

export interface OrderLineItem {
  readonly sku: string;
  readonly quantity: number;
  readonly size: ProductSize;
  readonly color: string;
  readonly designId: string;
}

export interface ShippingAddress {
  readonly name: string;
  readonly address1: string;
  readonly address2: string | null;
  readonly city: string;
  readonly province: string;
  readonly zip: string;
  readonly country: string;
}

export interface Order {
  readonly id: string;
  readonly shopifyOrderId: string;
  readonly customcatOrderId: string | null;
  readonly lineItems: readonly OrderLineItem[];
  readonly shippingAddress: ShippingAddress;
  readonly status: OrderStatus;
  readonly trackingNumber: string | null;
  readonly trackingUrl: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

// --- Content Pipeline Domain ---

export type ContentPlatform = 'tiktok' | 'instagram';

export type ContentStatus = 'draft' | 'scheduled' | 'published' | 'failed';

export interface ContentPost {
  readonly id: string;
  readonly productId: string;
  readonly platform: ContentPlatform;
  readonly caption: string;
  readonly mediaUrls: readonly string[];
  readonly scheduledAt: Date | null;
  readonly publishedAt: Date | null;
  readonly status: ContentStatus;
}

// --- Ads Pipeline Domain ---

export type AdStatus = 'draft' | 'pending_approval' | 'approved' | 'active' | 'paused' | 'rejected';

export interface AdCreative {
  readonly id: string;
  readonly productId: string;
  readonly headline: string;
  readonly primaryText: string;
  readonly imageUrl: string;
  readonly callToAction: string;
  readonly status: AdStatus;
}

export interface AdCampaign {
  readonly id: string;
  readonly name: string;
  readonly metaCampaignId: string | null;
  readonly adAccountId: string;
  readonly creatives: readonly AdCreative[];
  readonly dailyBudget: number;
  readonly status: AdStatus;
  readonly createdAt: Date;
}

// --- Config ---

export interface AppConfig {
  readonly shopify: {
    readonly shopName: string;
    readonly apiKey: string;
    readonly apiSecret: string;
    readonly accessToken: string;
  };
  readonly etsy: {
    readonly apiKey: string;
    readonly apiSecret: string;
    readonly accessToken: string;
    readonly shopId: string;
  };
  readonly customcat: {
    readonly apiKey: string;
    readonly apiUrl: string;
  };
  readonly anthropic: {
    readonly apiKey: string;
  };
  readonly openai: {
    readonly apiKey: string;
  };
  readonly meta: {
    readonly appId: string;
    readonly appSecret: string;
    readonly accessToken: string;
    readonly adAccountId: string;
    readonly pixelId: string;
  };
  readonly notifications: {
    readonly webhookUrl: string;
  };
  readonly app: {
    readonly nodeEnv: 'development' | 'production';
    readonly logLevel: 'debug' | 'info' | 'warn' | 'error';
  };
}
