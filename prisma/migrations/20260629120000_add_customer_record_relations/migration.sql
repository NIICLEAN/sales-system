-- AlterTable
ALTER TABLE "Sale" ADD COLUMN "customerRecordId" INTEGER;
ALTER TABLE "Sale" ADD CONSTRAINT "Sale_customerRecordId_fkey" FOREIGN KEY ("customerRecordId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "Quote" ADD COLUMN "customerRecordId" INTEGER;
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_customerRecordId_fkey" FOREIGN KEY ("customerRecordId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
