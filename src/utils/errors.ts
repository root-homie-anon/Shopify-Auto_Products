// ============================================================
// Banyakob — Domain Error Classes
// ============================================================

export class AppError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'AppError';
    this.code = code;
  }
}

export class ShopifyError extends AppError {
  constructor(message: string) {
    super(message, 'SHOPIFY_ERROR');
    this.name = 'ShopifyError';
  }
}

export class EtsyError extends AppError {
  constructor(message: string) {
    super(message, 'ETSY_ERROR');
    this.name = 'EtsyError';
  }
}

export class CustomCatError extends AppError {
  constructor(message: string) {
    super(message, 'CUSTOMCAT_ERROR');
    this.name = 'CustomCatError';
  }
}

export class FulfillmentError extends AppError {
  constructor(message: string) {
    super(message, 'FULFILLMENT_ERROR');
    this.name = 'FulfillmentError';
  }
}

export class ContentError extends AppError {
  constructor(message: string) {
    super(message, 'CONTENT_ERROR');
    this.name = 'ContentError';
  }
}

export class MetaAdsError extends AppError {
  constructor(message: string) {
    super(message, 'META_ADS_ERROR');
    this.name = 'MetaAdsError';
  }
}

export class ListingError extends AppError {
  constructor(message: string) {
    super(message, 'LISTING_ERROR');
    this.name = 'ListingError';
  }
}
