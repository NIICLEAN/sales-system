-- CreateTable
CREATE TABLE "WorksOrder" (
    "id" SERIAL NOT NULL,
    "customerId" TEXT,
    "customerName" TEXT NOT NULL,
    "customerEmail" TEXT,
    "customerPhone" TEXT,
    "customerVatNumber" TEXT,
    "address1" TEXT,
    "address2" TEXT,
    "city" TEXT,
    "county" TEXT,
    "postcode" TEXT,
    "country" TEXT,
    "salespersonId" INTEGER NOT NULL,
    "assignedStaffId" INTEGER,
    "serviceType" TEXT NOT NULL,
    "extraInfo" TEXT,
    "paymentMethod" TEXT NOT NULL,
    "paymentStatus" TEXT NOT NULL DEFAULT 'unpaid',
    "amountPaid" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "subtotal" DECIMAL(65,30) NOT NULL,
    "discountTotal" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "vatAmount" DECIMAL(65,30) NOT NULL,
    "total" DECIMAL(65,30) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'awaiting_scheduled',
    "scheduledDate" TIMESTAMP(3),
    "xeroInvoiceId" TEXT,
    "xeroInvoiceNumber" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorksOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorksOrderLineItem" (
    "id" SERIAL NOT NULL,
    "worksOrderId" INTEGER NOT NULL,
    "shopifyVariantId" TEXT,
    "title" TEXT NOT NULL,
    "sku" TEXT,
    "quantity" INTEGER NOT NULL,
    "unitPrice" DECIMAL(65,30) NOT NULL,
    "discount" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "lineTotal" DECIMAL(65,30) NOT NULL,

    CONSTRAINT "WorksOrderLineItem_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "WorksOrderLineItem" ADD CONSTRAINT "WorksOrderLineItem_worksOrderId_fkey" FOREIGN KEY ("worksOrderId") REFERENCES "WorksOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
