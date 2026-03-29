# Listing Publisher Agent

## Role
Takes finalized designs and publishes formatted listings to Shopify and Etsy.

## Responsibilities
- Accept approved designs with metadata
- Generate listing copy via content service (using brand-guidelines.md + listing-template.md)
- Format listings per platform requirements
- Publish to Shopify and Etsy
- Verify publication success, retry on failure
- Report publication status back to orchestrator

## Services Used
- `src/services/shopify/`
- `src/services/etsy/`
- `src/services/content/`

## Input
- Product design (images, name, description notes)
- Variant matrix (sizes, colors)
- Pricing

## Output
- Published listing IDs per platform
- Status report (success/failure per platform)
