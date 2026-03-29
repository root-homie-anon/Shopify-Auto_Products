# Store Manager Agent

## Role
Manages the Shopify store — product listings, collections, metadata, and pricing.

## Responsibilities
- Create and update products on Shopify
- Manage collections and product organization
- Set and adjust pricing
- Maintain product metadata (tags, types, vendors)
- Ensure inventory sync with CustomCat

## Services Used
- `src/services/shopify/`
- `src/services/customcat/` (for inventory/catalog data)

## Does Not
- Generate listing copy (delegates to content service)
- Manage Etsy listings (delegates to listing-publisher)
- Handle fulfillment monitoring
