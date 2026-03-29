# Banyakob — Master Project File

## System Overview
Banyakob is a Christian lifestyle apparel brand selling DTG-printed t-shirts through Shopify and Etsy, fulfilled via CustomCat. The system automates the full commerce pipeline — product listing creation, order fulfillment routing, and storefront management — so the operator spends time only on design and marketing decisions. Everything else runs without manual intervention.

---

## Session Start Hook
On every session start, fire the agent factory hook:
```
bash ~/.claude/hooks/session-start.sh "banyakob" "$(pwd)"
```
This loads existing agents, offers to create new ones if needed, and prepares the session.

---

## Orchestrator Behavior

This file is the root orchestrator. On session start:

1. Fire the session-start hook
2. Load state from `state/` if it exists
3. Ask the user: continue existing run, start a new one, or initialize a new sub-project
4. Spawn subagents scoped to their domain — they share no state unless explicitly passed
5. Multiple subagents can run in parallel

---

## Agent Team
All agents live in `.claude/agents/` and are shared across the project.

| Agent | Role |
|-------|------|
| `@orchestrator` | Drives the session, delegates tasks, manages state |
| `@store-manager` | Manages Shopify store — product listings, collections, metadata, pricing |
| `@listing-publisher` | Takes finalized designs and publishes formatted listings to Shopify and Etsy |
| `@fulfillment-monitor` | Monitors CustomCat order status, flags delays or errors |

---

## Project Structure

```
banyakob/
├── CLAUDE(1).md               ← this file, root orchestrator
├── TODO.md                    ← remaining tasks for next session
├── .claude/
│   └── agents/                ← agent definitions (orchestrator, store-manager, etc.)
├── .env                       ← secrets, never committed
├── .env.example               ← committed, documents required vars
├── .github/
│   └── workflows/             ← CI/CD pipelines (ci.yml, deploy.yml)
├── src/
│   ├── index.ts               ← CLI entry point
│   ├── config/                ← Zod-validated env config loader
│   ├── types/                 ← core type definitions
│   ├── utils/                 ← logger, domain error classes
│   ├── services/              ← shopify, customcat, etsy, meta, content, social
│   └── agents/                ← store-manager, listing-publisher, fulfillment-monitor, orchestrator
├── examples/                  ← sample product JSON files for CLI testing
├── state/                     ← runtime state, gitignored
├── shared/
│   ├── brand-guidelines.md    ← visual identity, tone, design language
│   └── listing-template.md   ← product title, description, tag templates
├── vitest.config.ts           ← test configuration
└── config.json                ← project config schema
```

---

## config.json Schema

```json
{
  "project": {
    "name": "Banyakob",
    "slug": "banyakob",
    "version": "1.0.0"
  },
  "credentials": {
    "shopify_api_key": ".env",
    "shopify_api_secret": ".env",
    "etsy_api_key": ".env",
    "customcat_api_key": ".env"
  },
  "agents": {},
  "features": {
    "etsy_sync": true,
    "fulfillment_monitoring": true,
    "listing_automation": true
  }
}
```

---

## System Pipelines

### 1. Commerce Pipeline — Fully Automated
Order received → CustomCat fulfillment routed → tracking updated → no manual intervention.

### 2. Content Pipeline — Fully Automated
Design approved by operator → mockup videos generated in batch → copy written → scheduled and posted to TikTok and Instagram automatically.

### 3. Ads Pipeline — Semi-Automated
Ad assets and copy generated automatically → operator reviews and approves → launches to Meta. No spend goes out without human approval.

---

## Platform Stack

| Layer | Tool |
|-------|------|
| Storefront | Shopify |
| Marketplace | Etsy (connected via Shopify) |
| Fulfillment | CustomCat |
| Design generation | AI — prompt engineering owned by operator |
| Listing copy | Claude (batch via prompt template) |
| Mockup videos | TBD — batch-capable video mockup tool (e.g. Botika, Krea.ai, Placeit) |
| Content scheduling | TBD — social scheduler (TikTok + Instagram) |
| Ads management | Meta Ads — semi-automated, human approval required before launch |

---

## Brand Identity

- **Brand name:** Banyakob
- **Niche:** Christian lifestyle apparel
- **Aesthetic:** Byzantine / Orthodox icon art meets urban streetwear — gold tones, sacred geometry, iconographic linework, modern composition
- **Logo:** Gold lion head — stays as-is, not subject to redesign
- **Tone:** Elevated, cultural, faith-driven — not generic church merch
- **Target buyer:** Faith-driven urban consumers across demographics — self-selects via aesthetic

---

## Product Specs

- **Blank:** Bella+Canvas 3001
- **Print method:** DTG — front and back
- **Print area:** TBD — confirm with CustomCat before designing
- **Fulfillment:** CustomCat — 2-3 business day production, US-based
- **Branding:** Packing insert card — specs and fee TBD, confirm with CustomCat

---

## GitHub Workflow

- `main` — production, protected, no direct pushes
- `dev` — integration branch
- `feature/[slug]` — per-feature branches, PR into dev
- `release/[version]` — cut from dev, merge into main

CI runs on every PR: lint → typecheck → test → build.
Deployments trigger automatically on merge to `main`.

---

## Shared Resources

### API Keys
All keys in `.env` at project root. See `.env.example` for required vars. Never commit `.env`.

### Shared Utilities
```
shared/
├── brand-guidelines.md    ← visual identity, tone, color palette, design language
└── listing-template.md   ← reusable product title, description, and tag structure
```

---

## Automation Assumptions
- Everything is automated unless explicitly noted as human-handled
- All long-running tasks are async with state written to `state/`
- Agents are stateless — all context passed explicitly per invocation
- Errors surface to a notification channel (configure in `.env`)
- No manual steps in the critical path

**Human-handled tasks:**
- AI design prompt engineering and design generation
- Final design approval before publishing

---

## Code Standards
- TypeScript strict mode — no `any`, explicit return types
- Naming: kebab-case files, PascalCase classes/types, camelCase functions, UPPER_SNAKE_CASE constants
- Formatting: Prettier, single quotes, semicolons, 2-space indent, 100 char line width
- Imports: external libs → internal utils → services → types
- Async: always async/await, never callbacks
- Errors: custom error classes per domain

---

## Build Progress (updated 2026-03-28)

### Completed
- [x] Project scaffold — TypeScript strict, ESM, package.json, tsconfig, eslint, prettier
- [x] `.env.example` with all 22 required env vars
- [x] `.gitignore` — node_modules, dist, .env, state/
- [x] `config.json` — project config schema
- [x] Zod-validated config loader (`src/config/`)
- [x] Core type definitions (`src/types/`) — Product, Order, Listing, ContentPost, AdCampaign, AppConfig
- [x] Domain error classes (`src/utils/errors.ts`) — ShopifyError, EtsyError, CustomCatError, etc.
- [x] Pino logger factory (`src/utils/logger.ts`)
- [x] **Shopify service** — product CRUD, collections, orders, tracking updates
- [x] **CustomCat service** — order submission, status tracking, catalog, print area specs
- [x] **Content service** — listing copy, social captions, ad copy via Claude API
- [x] **Meta Ads service** — campaigns, ad sets, creatives (always PAUSED until human approval)
- [x] **Etsy service** — listings, images, sync from Shopify
- [x] **Social service** — adapter pattern with TikTok/Instagram stubs (ready to swap when tool selected)
- [x] **Store Manager agent** — Shopify product management, inventory sync with CustomCat
- [x] **Listing Publisher agent** — end-to-end publish pipeline (generate copy → Shopify → Etsy)
- [x] **Fulfillment Monitor agent** — order tracking, SLA enforcement, alerts
- [x] **Orchestrator agent** — top-level coordinator, delegates to all three domain agents
- [x] CLI entry point (`src/index.ts`) — publish, publish-batch, monitor, health, status commands
- [x] 143 unit tests — data mapping, error handling, SLA logic, edge cases
- [x] CI/CD workflows (`.github/workflows/ci.yml`, `deploy.yml`)
- [x] `dev` branch created, PR #1 open to `main`
- [x] Sample product JSON files (`examples/`)
- [x] Vitest config with coverage thresholds
- [x] Date deserialization in CLI JSON parser
- [x] Agent definitions (`.claude/agents/`) — orchestrator, store-manager, listing-publisher, fulfillment-monitor
- [x] Brand guidelines and listing template (`shared/`)

### Remaining — Vendor Decisions (operator-owned)
- [ ] Confirm Bella+Canvas 3001 exact print area specs — front and back
- [ ] Confirm packing insert specs, per-order fee, and inventory ship-to address
- [ ] Select batch-capable video mockup tool (evaluate Botika, Krea.ai, Placeit)
- [ ] Select social scheduling tool for TikTok and Instagram
- [ ] Confirm Meta Ads account setup and pixel installation on Shopify
- [ ] Design prompt engineering — owned by operator

### Remaining — Engineering (see TODO.md for full breakdown)
- [ ] Fill `.env` with real credentials
- [ ] Sandbox testing against Shopify, CustomCat, Etsy APIs
- [ ] Integration tests
- [ ] Implement social adapter once tool is selected
- [ ] Add Meta page ID to config (needed for ad creative creation)
- [ ] Deploy pipeline configuration
- [ ] Webhook/notification channel setup

## Initialization Checklist
- [x] Clone repo and run `npm install`
- [ ] Copy `.env.example` → `.env` and fill in all values
- [ ] Verify agents load correctly
- [ ] Confirm CI pipeline is green
