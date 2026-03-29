# Banyakob — Remaining Tasks

Last updated: 2026-03-29

---

## Priority 1 — Credentials & Sandbox Testing

> **BLOCKER:** Pipeline cannot be tested until Shopify credentials are in place.
> Shopify app setup is the critical path — everything downstream depends on it.

- [ ] **Create Shopify custom app** — go to Shopify Admin → Settings → Apps → Develop apps → create app, grant Admin API scopes (products, orders, fulfillments), get access token
- [ ] Add Shopify credentials to keymaster: `SHOPIFY_SHOP_NAME`, `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_ACCESS_TOKEN`
- [ ] Add CustomCat API key to keymaster — **BLOCKER:** need CustomCat account set up first
- [ ] Run Etsy OAuth flow for Banyakob shop — reuse existing `ETSY_API_KEY`/`ETSY_API_SECRET` from printpilot, get new `ETSY_ACCESS_TOKEN` + `ETSY_SHOP_ID`
- [ ] Run `keymaster sync Shopify-Auto_Products` to generate `.env`
- [ ] Smoke test: `npx tsx src/index.ts publish examples/sample-product.json`
- [ ] Smoke test: `npx tsx src/index.ts publish-batch examples/sample-batch.json`
- [ ] Smoke test: `npx tsx src/index.ts monitor`

## Priority 2 — Integration Tests

> **BLOCKED BY:** P1 — needs live credentials before tests can be written against real APIs

- [ ] Write integration tests for Shopify service against dev store sandbox
- [ ] Write integration tests for CustomCat order lifecycle (submit → status → tracking)
- [ ] Write integration tests for Etsy listing sync pipeline
- [ ] Write integration test for full orchestrator pipeline (publish → verify)
- [ ] Set up test fixtures with real API response shapes
- [ ] Add integration test CI workflow (runs on `dev` only, requires secrets)

## Priority 3 — Known Gaps

- [x] ~~**Image generation service**~~ — BFL Flux 2 Pro integrated (`src/services/image/`), wired into listing-publisher and orchestrator (completed 2026-03-28)
- [ ] **Meta Ads: Add `pageId` to AppConfig** — `createAdCreative` currently uses `adAccountId` as `page_id` in `object_story_spec`, but the Graph API requires a Facebook Page ID. Add `META_PAGE_ID` to `.env.example`, `AppConfig['meta']`, and the config loader.
- [ ] **Social adapter implementation** — **BLOCKED BY:** vendor decision on scheduling tool (Botika/Later/Buffer/etc.). Implement `SocialPlatformAdapter` for TikTok and Instagram in `src/services/social/index.ts`
- [ ] **Video mockup pipeline** — **BLOCKED BY:** vendor decision on video tool. Add service at `src/services/video/index.ts` and wire into content pipeline
- [ ] **Webhook/notification setup** — configure `NOTIFICATION_WEBHOOK_URL` in `.env` (Slack, Discord, or custom endpoint) for fulfillment alerts
- [ ] **Product JSON validation** — add Zod schema to validate product JSON input in the CLI before passing to orchestrator (currently just casts to `Product`)
- [ ] **Date fields in Product JSON** — CLI has a JSON reviver for ISO dates, but a Zod schema would be more robust

## Priority 4 — Production Readiness

> **BLOCKED BY:** P1 smoke tests — no point deploying until the pipeline runs locally

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
