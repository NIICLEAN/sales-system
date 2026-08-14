import { Prisma } from "@prisma/client";

import prisma from "../db.server";

type InvoiceDiscountMetaRow = {
  saleId: number;
  discountType: string | null;
  discountValue: number | null;
  discountAmount: number | null;
};

let tableReady = false;

async function ensureTable() {
  if (tableReady) return;

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "InvoiceDiscountMeta" (
      "saleId" INTEGER PRIMARY KEY,
      "discountType" TEXT,
      "discountValue" DOUBLE PRECISION,
      "discountAmount" DOUBLE PRECISION,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT NOW(),
      CONSTRAINT "InvoiceDiscountMeta_saleId_fkey"
        FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE CASCADE
    )
  `);

  await prisma.$executeRawUnsafe(`
    ALTER TABLE "InvoiceDiscountMeta"
    ADD COLUMN IF NOT EXISTS "discountType" TEXT
  `);

  await prisma.$executeRawUnsafe(`
    ALTER TABLE "InvoiceDiscountMeta"
    ADD COLUMN IF NOT EXISTS "discountValue" DOUBLE PRECISION
  `);

  await prisma.$executeRawUnsafe(`
    ALTER TABLE "InvoiceDiscountMeta"
    ADD COLUMN IF NOT EXISTS "discountAmount" DOUBLE PRECISION
  `);

  tableReady = true;
}

export async function upsertInvoiceDiscountMeta({
  saleId,
  discountType,
  discountValue,
  discountAmount,
}: {
  saleId: number;
  discountType?: string | null;
  discountValue?: number | null;
  discountAmount?: number | null;
}) {
  await ensureTable();

  const normalizedType = String(discountType || "").trim() || null;
  const normalizedValue = Number.isFinite(Number(discountValue)) ? Number(discountValue) : null;
  const normalizedAmount = Number.isFinite(Number(discountAmount)) ? Number(discountAmount) : null;

  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO "InvoiceDiscountMeta" (
      "saleId", "discountType", "discountValue", "discountAmount", "updatedAt"
    )
    VALUES (
      ${saleId}, ${normalizedType}, ${normalizedValue}, ${normalizedAmount}, NOW()
    )
    ON CONFLICT ("saleId")
    DO UPDATE SET
      "discountType" = EXCLUDED."discountType",
      "discountValue" = EXCLUDED."discountValue",
      "discountAmount" = EXCLUDED."discountAmount",
      "updatedAt" = NOW()
  `);
}

export async function getInvoiceDiscountMeta(saleId: number) {
  await ensureTable();

  const rows = await prisma.$queryRaw<InvoiceDiscountMetaRow[]>(Prisma.sql`
    SELECT "saleId", "discountType", "discountValue", "discountAmount"
    FROM "InvoiceDiscountMeta"
    WHERE "saleId" = ${saleId}
    LIMIT 1
  `);

  const row = rows[0];
  if (!row) {
    return {
      discountType: null as string | null,
      discountValue: null as number | null,
      discountAmount: null as number | null,
    };
  }

  return {
    discountType: row.discountType || null,
    discountValue: row.discountValue ?? null,
    discountAmount: row.discountAmount ?? null,
  };
}
