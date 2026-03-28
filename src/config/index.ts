import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

import type { AppConfig } from '../types/index.js';

// Load .env file
loadDotenv();

const envSchema = z.object({
  // Shopify
  SHOPIFY_SHOP_NAME: z.string().min(1),
  SHOPIFY_API_KEY: z.string().min(1),
  SHOPIFY_API_SECRET: z.string().min(1),
  SHOPIFY_ACCESS_TOKEN: z.string().min(1),

  // Etsy
  ETSY_API_KEY: z.string().min(1),
  ETSY_API_SECRET: z.string().min(1),
  ETSY_ACCESS_TOKEN: z.string().min(1),
  ETSY_SHOP_ID: z.string().min(1),

  // CustomCat
  CUSTOMCAT_API_KEY: z.string().min(1),
  CUSTOMCAT_API_URL: z.string().url().default('https://api.customcat.com'),

  // Anthropic
  ANTHROPIC_API_KEY: z.string().min(1),

  // OpenAI
  OPENAI_API_KEY: z.string().min(1),

  // Meta
  META_APP_ID: z.string().min(1),
  META_APP_SECRET: z.string().min(1),
  META_ACCESS_TOKEN: z.string().min(1),
  META_AD_ACCOUNT_ID: z.string().min(1),
  META_PIXEL_ID: z.string().min(1),

  // Social
  TIKTOK_ACCESS_TOKEN: z.string().default(''),
  INSTAGRAM_ACCESS_TOKEN: z.string().default(''),

  // Notifications
  NOTIFICATION_WEBHOOK_URL: z.string().default(''),

  // App
  NODE_ENV: z.enum(['development', 'production']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function loadConfig(): AppConfig {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const missing = result.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new ConfigError(`Invalid environment configuration:\n${missing}`);
  }

  const env = result.data;

  return {
    shopify: {
      shopName: env.SHOPIFY_SHOP_NAME,
      apiKey: env.SHOPIFY_API_KEY,
      apiSecret: env.SHOPIFY_API_SECRET,
      accessToken: env.SHOPIFY_ACCESS_TOKEN,
    },
    etsy: {
      apiKey: env.ETSY_API_KEY,
      apiSecret: env.ETSY_API_SECRET,
      accessToken: env.ETSY_ACCESS_TOKEN,
      shopId: env.ETSY_SHOP_ID,
    },
    customcat: {
      apiKey: env.CUSTOMCAT_API_KEY,
      apiUrl: env.CUSTOMCAT_API_URL,
    },
    anthropic: {
      apiKey: env.ANTHROPIC_API_KEY,
    },
    openai: {
      apiKey: env.OPENAI_API_KEY,
    },
    meta: {
      appId: env.META_APP_ID,
      appSecret: env.META_APP_SECRET,
      accessToken: env.META_ACCESS_TOKEN,
      adAccountId: env.META_AD_ACCOUNT_ID,
      pixelId: env.META_PIXEL_ID,
    },
    notifications: {
      webhookUrl: env.NOTIFICATION_WEBHOOK_URL,
    },
    app: {
      nodeEnv: env.NODE_ENV,
      logLevel: env.LOG_LEVEL,
    },
  };
}
