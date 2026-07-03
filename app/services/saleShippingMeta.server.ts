import { Prisma } from "@prisma/client";

import prisma from "../db.server";

export type ShippingMethod = "Collection" | "Delivery";

type SaleShippingMetaRow = {
  saleId: number;
  shippingMethod: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  carrierName: string | null;
  fulfillmentStatus: string | null;
  deliveryStatus: string | null;
  deliveryMethod: string | null;
};

let tableReady = false;

async function ensureTable() {
  if (tableReady) return;

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "SaleShippingMeta" (
      "saleId" INTEGER PRIMARY KEY,
      "shippingMethod" TEXT,
      "trackingNumber" TEXT,
      "trackingUrl" TEXT,
      "carrierName" TEXT,
      "fulfillmentStatus" TEXT,
      "deliveryStatus" TEXT,
      "deliveryMethod" TEXT,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT NOW(),
      CONSTRAINT "SaleShippingMeta_saleId_fkey"
        FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE CASCADE
    )
  `);

  await prisma.$executeRawUnsafe(`
    ALTER TABLE "SaleShippingMeta"
    ADD COLUMN IF NOT EXISTS "fulfillmentStatus" TEXT
  `);

  await prisma.$executeRawUnsafe(`
    ALTER TABLE "SaleShippingMeta"
    ADD COLUMN IF NOT EXISTS "deliveryStatus" TEXT
  `);

  await prisma.$executeRawUnsafe(`
    ALTER TABLE "SaleShippingMeta"
    ADD COLUMN IF NOT EXISTS "deliveryMethod" TEXT
  `);

  await prisma.$executeRawUnsafe(`
    ALTER TABLE "SaleShippingMeta"
    ADD COLUMN IF NOT EXISTS "trackingUrl" TEXT
  `);

  await prisma.$executeRawUnsafe(`
    ALTER TABLE "SaleShippingMeta"
    ADD COLUMN IF NOT EXISTS "carrierName" TEXT
  `);

  tableReady = true;
}

function normalizeShippingMethod(value: string): ShippingMethod {
  return value === "Delivery" ? "Delivery" : "Collection";
}

export async function upsertSaleShippingMeta({
  saleId,
  shippingMethod,
  trackingNumber,
  trackingUrl,
  carrierName,
  fulfillmentStatus,
  deliveryStatus,
  deliveryMethod,
}: {
  saleId: number;
  shippingMethod: string;
  trackingNumber?: string | null;
  trackingUrl?: string | null;
  carrierName?: string | null;
  fulfillmentStatus?: string | null;
  deliveryStatus?: string | null;
  deliveryMethod?: string | null;
}) {
  await ensureTable();

  const normalizedMethod = normalizeShippingMethod(String(shippingMethod || "Collection"));
  const normalizedTracking = String(trackingNumber || "").trim() || null;
  const normalizedTrackingUrl = String(trackingUrl || "").trim() || null;
  const normalizedCarrierName = String(carrierName || "").trim() || null;
  const normalizedFulfillmentStatus = String(fulfillmentStatus || "").trim() || null;
  const normalizedDeliveryStatus = String(deliveryStatus || "").trim() || null;
  const normalizedDeliveryMethod = String(deliveryMethod || "").trim() || null;

  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO "SaleShippingMeta" (
      "saleId", "shippingMethod", "trackingNumber", "trackingUrl", "carrierName", "fulfillmentStatus", "deliveryStatus", "deliveryMethod", "updatedAt"
    )
    VALUES (
      ${saleId}, ${normalizedMethod}, ${normalizedTracking}, ${normalizedTrackingUrl}, ${normalizedCarrierName}, ${normalizedFulfillmentStatus}, ${normalizedDeliveryStatus}, ${normalizedDeliveryMethod}, NOW()
    )
    ON CONFLICT ("saleId")
    DO UPDATE SET
      "shippingMethod" = EXCLUDED."shippingMethod",
      "trackingNumber" = EXCLUDED."trackingNumber",
      "trackingUrl" = EXCLUDED."trackingUrl",
      "carrierName" = EXCLUDED."carrierName",
      "fulfillmentStatus" = EXCLUDED."fulfillmentStatus",
      "deliveryStatus" = EXCLUDED."deliveryStatus",
      "deliveryMethod" = EXCLUDED."deliveryMethod",
      "updatedAt" = NOW()
  `);
}

export async function getSaleShippingMeta(saleId: number) {
  await ensureTable();

  const rows = await prisma.$queryRaw<SaleShippingMetaRow[]>(Prisma.sql`
    SELECT "saleId", "shippingMethod", "trackingNumber", "trackingUrl", "carrierName", "fulfillmentStatus", "deliveryStatus", "deliveryMethod"
    FROM "SaleShippingMeta"
    WHERE "saleId" = ${saleId}
    LIMIT 1
  `);

  const row = rows[0];
  if (!row) {
    return {
      shippingMethod: "Collection" as ShippingMethod,
      trackingNumber: null,
      trackingUrl: null,
      carrierName: null,
      fulfillmentStatus: null,
      deliveryStatus: null,
      deliveryMethod: null,
    };
  }

  return {
    shippingMethod: normalizeShippingMethod(String(row.shippingMethod || "Collection")),
    trackingNumber: row.trackingNumber || null,
    trackingUrl: row.trackingUrl || null,
    carrierName: row.carrierName || null,
    fulfillmentStatus: row.fulfillmentStatus || null,
    deliveryStatus: row.deliveryStatus || null,
    deliveryMethod: row.deliveryMethod || null,
  };
}

export async function getSaleShippingMetaBySaleIds(saleIds: number[]) {
  await ensureTable();

  if (saleIds.length === 0) {
    return new Map<number, {
      shippingMethod: ShippingMethod;
      trackingNumber: string | null;
      trackingUrl: string | null;
      carrierName: string | null;
      fulfillmentStatus: string | null;
      deliveryStatus: string | null;
      deliveryMethod: string | null;
    }>();
  }

  const uniqueIds = Array.from(new Set(saleIds)).filter((id) => Number.isFinite(id));

  const rows = await prisma.$queryRaw<SaleShippingMetaRow[]>(Prisma.sql`
    SELECT "saleId", "shippingMethod", "trackingNumber", "trackingUrl", "carrierName", "fulfillmentStatus", "deliveryStatus", "deliveryMethod"
    FROM "SaleShippingMeta"
    WHERE "saleId" IN (${Prisma.join(uniqueIds)})
  `);

  const map = new Map<number, {
    shippingMethod: ShippingMethod;
    trackingNumber: string | null;
    trackingUrl: string | null;
    carrierName: string | null;
    fulfillmentStatus: string | null;
    deliveryStatus: string | null;
    deliveryMethod: string | null;
  }>();

  for (const row of rows) {
    map.set(row.saleId, {
      shippingMethod: normalizeShippingMethod(String(row.shippingMethod || "Collection")),
      trackingNumber: row.trackingNumber || null,
      trackingUrl: row.trackingUrl || null,
      carrierName: row.carrierName || null,
      fulfillmentStatus: row.fulfillmentStatus || null,
      deliveryStatus: row.deliveryStatus || null,
      deliveryMethod: row.deliveryMethod || null,
    });
  }

  return map;
}
