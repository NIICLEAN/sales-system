-- AlterTable
ALTER TABLE "WorkSchedule" ADD COLUMN     "customCustomerName" TEXT,
ADD COLUMN     "customInvoiceNumber" TEXT,
ALTER COLUMN "saleId" DROP NOT NULL;
