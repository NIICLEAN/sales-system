-- Create enum types
CREATE TYPE "VatType" AS ENUM ('Standard', 'Exempt', 'CrossBorder');
CREATE TYPE "PaymentMethod" AS ENUM ('Cash', 'Card', 'BankTransfer', 'MyPos', 'Worldpay', 'Other');

-- Add vatType column to Sale table
ALTER TABLE "Sale" ADD COLUMN "vatType" "VatType" NOT NULL DEFAULT 'Standard';

-- Add vatType column to Quote table
ALTER TABLE "Quote" ADD COLUMN "vatType" "VatType" NOT NULL DEFAULT 'Standard';

-- Create Payment table
CREATE TABLE "Payment" (
    "id" SERIAL NOT NULL PRIMARY KEY,
    "saleId" INTEGER NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "provider" TEXT,
    "reference" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Payment_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Create index on Payment.saleId for performance
CREATE INDEX "Payment_saleId_idx" ON "Payment"("saleId");

-- Make assignedStaffId nullable in WorkSchedule
ALTER TABLE "WorkSchedule" 
  ALTER COLUMN "assignedStaffId" DROP NOT NULL;
