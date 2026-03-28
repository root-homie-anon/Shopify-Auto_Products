# Banyakob — Remaining Tasks

Last updated: 2026-03-28

---

## Priority 1 — Credentials & Sandbox Testing

- [ ] Copy `.env.example` → `.env` and fill in all API credentials
- [ ] Set up Shopify dev store (or use existing) and test product creation
- [ ] Test CustomCat API connectivity — verify order submission and status endpoints
- [ ] Test Etsy API connectivity — verify listing creation and image upload
- [ ] Test Content service — run `npx tsx src/index.ts publish examples/sample-product.json` end-to-end
- [ ] Test batch pipeline — run `npx tsx src/index.ts publish-batch examples/sample-batch.json`
- [ ] Test fulfillment monitor — run `npx tsx src/index.ts monitor`

## Priority 2 — Integration Tests

- [ ] Write integration tests for Shopify service against dev store sandbox
- [ ] Write integration tests for CustomCat order lifecycle (submit → status → tracking)
- [ ] Write integration tests for Etsy listing sync pipeline
- [ ] Write integration test for full orchestrator pipeline (publish → verify)
- [ ] Set up test fixtures with real API response shapes
- [ ] Add integration test CI workflow (runs on `dev` only, requires secrets)

## Priority 3 — Known Gaps

- [ ] **Meta Ads: Add `pageId` to AppConfig** — `createAdCreative` currently uses `adAccountId` as `page_id` in `object_story_spec`, but the Graph API requires a Facebook Page ID. Add `META_PAGE_ID` to `.env.example`, `AppConfig['meta']`, and the config loader.
- [ ] **Social adapter implementation** — once a scheduling tool is selected (Botika/Later/Buffer/etc.), implement the `SocialPlatformAdapter` for TikTok and Instagram in `src/services/social/index.ts`
- [ ] **Video mockup pipeline** — once a video mockup tool is selected, add a new service at `src/services/video/index.ts` and wire into the content pipeline
- [ ] **Webhook/notification setup** — configure `NOTIFICATION_WEBHOOK_URL` in `.env` (Slack, Discord, or custom endpoint) for fulfillment alerts
- [ ] **Product JSON validation** — add Zod schema to validate product JSON input in the CLI before passing to orchestrator (currently just casts to `Product`)
- [ ] **Date fields in Product JSON** — CLI has a JSON reviver for ISO dates, but a Zod schema would be more robust

## Priority 4 — Production Readiness

- [ ] **Deploy pipeline** — select deployment platform (Railway/Render/Fly.io) and configure `.github/workflows/deploy.yml`
- [ ] **Cron scheduling** — set up recurring fulfillment monitoring (e.g., every 30 minutes via cron or serverless scheduler)
- [ ] **Rate limiting** — add rate limit handling/backoff for Shopify (40 req/s), Etsy (10 req/s), and Meta APIs
- [ ] **Logging infrastructure** — configure log aggregation (Datadog, Logtail, or similar) for production pino output
- [ ] **Error alerting** — wire up error notifications beyond fulfillment (e.g., listing publish failures, API outages)
- [ ] **Health check endpoint** — if deployed as a service, expose `/health` for uptime monitoring
- [ ] **Secrets management** — configure GitHub Actions secrets for CI integration tests and deployment

## Priority 5 — Vendor Decisions (Operator-Owned)

- [ ] Confirm Bella+Canvas 3001 print area specs (front and back) with CustomCat
- [ ] Confirm packing insert specs and per-order fee with CustomCat
- [ ] Select video mockup tool — evaluate Botika, Krea.ai, Placeit
- [ ] Select social scheduling tool for TikTok + Instagram
- [ ] Confirm Meta Ads account setup and pixel installation on Shopify
- [ ] Complete design prompt engineering workflow

---

## Quick Reference — CLI Commands

```bash
# Single product publish
npx tsx src/index.ts publish examples/sample-product.json

# Batch publish
npx tsx src/index.ts publish-batch examples/sample-batch.json

# Fulfillment monitoring
npx tsx src/index.ts monitor

# Store health check
npx tsx src/index.ts health

# Session status
npx tsx src/index.ts status

# Run tests
npm test

# Type check
npm run typecheck

# Lint
npm run lint
```
