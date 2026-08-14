-- Enable pg_trgm for fast ILIKE searches using GIN indexes
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Index for ORDER BY createdAt DESC (primary sort on invoices list)
CREATE INDEX IF NOT EXISTS "Sale_createdAt_idx" ON "Sale" ("createdAt" DESC);

-- Index for paymentStatus filter
CREATE INDEX IF NOT EXISTS "Sale_paymentStatus_idx" ON "Sale" ("paymentStatus");

-- GIN trigram indexes for fast case-insensitive text search
CREATE INDEX IF NOT EXISTS "Sale_customerName_trgm_idx" ON "Sale" USING GIN ("customerName" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Sale_shopifyOrderName_trgm_idx" ON "Sale" USING GIN ("shopifyOrderName" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Sale_reference_trgm_idx" ON "Sale" USING GIN ("reference" gin_trgm_ops);

-- Index on staffId for the staff lookup join
CREATE INDEX IF NOT EXISTS "Sale_staffId_idx" ON "Sale" ("staffId");

-- SaleShippingMeta: saleId is PRIMARY KEY so already indexed;
-- but add index on shippingMethod for the shipping filter query
CREATE INDEX IF NOT EXISTS "SaleShippingMeta_shippingMethod_idx" ON "SaleShippingMeta" ("shippingMethod");
