-- CreateTable
CREATE TABLE "XeroConnection" (
    "id" SERIAL NOT NULL,
    "tenantId" TEXT NOT NULL,
    "tokenSet" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "XeroConnection_pkey" PRIMARY KEY ("id")
);
