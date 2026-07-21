import { Prisma } from "@prisma/client";

import prisma from "../db.server";

type SaleLineItemInput = {
  shopifyVariantId?: string | null;
  title: string;
  sku?: string | null;
  imageUrl?: string | null;
  quantity: number;
  unitPrice: number;
  discount: number;
  lineTotal: number;
  isCustom?: boolean;
};

type SaleInsertInput = {
  shopifyOrderId?: string | null;
  shopifyOrderName?: string | null;
  customerId?: string | null;
  customerName: string;
  customerEmail?: string | null;
  customerVatNumber?: string | null;
  customerPhone?: string | null;
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  county?: string | null;
  postcode?: string | null;
  country?: string | null;
  reference?: string | null;
  paymentMethod: string;
  subtotal: number;
  discountTotal: number;
  vatAmount: number;
  total: number;
  amountPaid?: number;
  balanceDue?: number;
  paymentStatus?: string;
  depositPaid?: boolean;
  vatType?: string;
  staffId: number;
  createdAt?: Date;
};

type SaleUpdateInput = Partial<SaleInsertInput>;

const tableColumnCache = new Map<string, Promise<Set<string>>>();

async function getTableColumns(tableName: string) {
  let cached = tableColumnCache.get(tableName);

  if (!cached) {
    cached = prisma
      .$queryRaw<Array<{ column_name: string }>>(Prisma.sql`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND lower(table_name) = lower(${tableName})
      `)
      .then((rows) => new Set(rows.map((row) => row.column_name)));

    tableColumnCache.set(tableName, cached);
  }

  return cached;
}

function toColumnSql(columnName: string) {
  return Prisma.raw(`"${columnName}"`);
}

export async function createSaleCompat({
  sale,
  lineItems = [],
}: {
  sale: SaleInsertInput;
  lineItems?: SaleLineItemInput[];
}) {
  const saleColumns = await getTableColumns("Sale");

  const saleEntries = Object.entries(sale).filter(
    ([columnName, value]) => saleColumns.has(columnName) && value !== undefined,
  );

  const insertedSaleRows = await prisma.$queryRaw<Array<{ id: number }>>(Prisma.sql`
    INSERT INTO "Sale" (${Prisma.join(saleEntries.map(([columnName]) => toColumnSql(columnName)))})
    VALUES (${Prisma.join(saleEntries.map(([, value]) => Prisma.sql`${value}`))})
    RETURNING "id"
  `);

  const saleId = insertedSaleRows[0]?.id;

  if (!saleId) {
    throw new Error("Failed to create sale record");
  }

  if (lineItems.length === 0) {
    return { id: saleId };
  }

  const lineItemColumns = await getTableColumns("SaleLineItem");

  for (const lineItem of lineItems) {
    const lineItemEntries = Object.entries({ saleId, ...lineItem }).filter(
      ([columnName, value]) => lineItemColumns.has(columnName) && value !== undefined,
    );

    await prisma.$executeRaw(Prisma.sql`
      INSERT INTO "SaleLineItem" (${Prisma.join(lineItemEntries.map(([columnName]) => toColumnSql(columnName)))})
      VALUES (${Prisma.join(lineItemEntries.map(([, value]) => Prisma.sql`${value}`))})
    `);
  }

  return { id: saleId };
}

export async function updateSaleCompat({
  saleId,
  sale,
  lineItems,
  replaceLineItems = false,
}: {
  saleId: number;
  sale: SaleUpdateInput;
  lineItems?: SaleLineItemInput[];
  replaceLineItems?: boolean;
}) {
  const saleColumns = await getTableColumns("Sale");

  const saleEntries = Object.entries(sale).filter(
    ([columnName, value]) => saleColumns.has(columnName) && value !== undefined,
  );

  if (saleEntries.length > 0) {
    await prisma.$executeRaw(Prisma.sql`
      UPDATE "Sale"
      SET ${Prisma.join(
        saleEntries.map(
          ([columnName, value]) => Prisma.sql`${toColumnSql(columnName)} = ${value}`,
        ),
        ", ",
      )}
      WHERE "id" = ${saleId}
    `);
  }

  if (!replaceLineItems) {
    return { id: saleId };
  }

  await prisma.saleLineItem.deleteMany({ where: { saleId } });

  if (!lineItems || lineItems.length === 0) {
    return { id: saleId };
  }

  const lineItemColumns = await getTableColumns("SaleLineItem");

  for (const lineItem of lineItems) {
    const lineItemEntries = Object.entries({ saleId, ...lineItem }).filter(
      ([columnName, value]) => lineItemColumns.has(columnName) && value !== undefined,
    );

    await prisma.$executeRaw(Prisma.sql`
      INSERT INTO "SaleLineItem" (${Prisma.join(lineItemEntries.map(([columnName]) => toColumnSql(columnName)))})
      VALUES (${Prisma.join(lineItemEntries.map(([, value]) => Prisma.sql`${value}`))})
    `);
  }

  return { id: saleId };
}