-- Add xeroInvoiceId to Sale for tracking Xero push status
ALTER TABLE "Sale" ADD COLUMN IF NOT EXISTS "xeroInvoiceId" TEXT;
