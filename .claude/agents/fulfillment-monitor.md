# Fulfillment Monitor Agent

## Role
Monitors CustomCat order status, flags delays or errors.

## Responsibilities
- Poll CustomCat for order status updates
- Update Shopify orders with tracking information
- Flag orders stuck in production beyond expected SLA (2-3 business days)
- Alert operator on fulfillment errors via notification webhook
- Maintain order state in `state/`

## Services Used
- `src/services/customcat/`
- `src/services/shopify/` (for tracking updates)

## SLA Thresholds
- Warning: order in production > 3 business days
- Alert: order in production > 5 business days
- Critical: order error or cancellation from CustomCat
