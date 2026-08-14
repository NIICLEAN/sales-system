CREATE TABLE IF NOT EXISTS "Customer" (
  "id" SERIAL PRIMARY KEY,
  "shopifyId" TEXT,
  "companyName" TEXT,
  "name" TEXT NOT NULL,
  "billingAddress1" TEXT,
  "billingAddress2" TEXT,
  "billingCity" TEXT,
  "billingCounty" TEXT,
  "billingPostcode" TEXT,
  "billingCountry" TEXT,
  "deliveryAddress1" TEXT,
  "deliveryAddress2" TEXT,
  "deliveryCity" TEXT,
  "deliveryCounty" TEXT,
  "deliveryPostcode" TEXT,
  "deliveryCountry" TEXT,
  "email" TEXT,
  "mobile" TEXT,
  "vatNumber" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE "Sale" ADD COLUMN IF NOT EXISTS "customerRecordId" INTEGER;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'Sale_customerRecordId_fkey'
  ) THEN
    ALTER TABLE "Sale"
      ADD CONSTRAINT "Sale_customerRecordId_fkey"
      FOREIGN KEY ("customerRecordId")
      REFERENCES "Customer"("id")
      ON DELETE SET NULL
      ON UPDATE CASCADE;
  END IF;
END $$;

ALTER TABLE "Quote" ADD COLUMN IF NOT EXISTS "customerRecordId" INTEGER;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'Quote_customerRecordId_fkey'
  ) THEN
    ALTER TABLE "Quote"
      ADD CONSTRAINT "Quote_customerRecordId_fkey"
      FOREIGN KEY ("customerRecordId")
      REFERENCES "Customer"("id")
      ON DELETE SET NULL
      ON UPDATE CASCADE;
  END IF;
END $$;
