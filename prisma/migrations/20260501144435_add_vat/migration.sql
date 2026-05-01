-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Sale" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shopifyOrderId" TEXT,
    "shopifyOrderName" TEXT,
    "customerId" TEXT,
    "customerName" TEXT NOT NULL,
    "customerEmail" TEXT,
    "customerVatNumber" TEXT,
    "vatAmount" REAL NOT NULL DEFAULT 0,
    "customerPhone" TEXT,
    "address1" TEXT,
    "address2" TEXT,
    "city" TEXT,
    "county" TEXT,
    "postcode" TEXT,
    "country" TEXT,
    "reference" TEXT,
    "paymentMethod" TEXT NOT NULL,
    "subtotal" REAL NOT NULL DEFAULT 0,
    "discountTotal" REAL NOT NULL DEFAULT 0,
    "total" REAL NOT NULL DEFAULT 0,
    "staffId" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Sale_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Sale" ("address1", "address2", "city", "country", "county", "createdAt", "customerEmail", "customerId", "customerName", "customerPhone", "discountTotal", "id", "paymentMethod", "postcode", "reference", "shopifyOrderId", "shopifyOrderName", "staffId", "subtotal", "total") SELECT "address1", "address2", "city", "country", "county", "createdAt", "customerEmail", "customerId", "customerName", "customerPhone", "discountTotal", "id", "paymentMethod", "postcode", "reference", "shopifyOrderId", "shopifyOrderName", "staffId", "subtotal", "total" FROM "Sale";
DROP TABLE "Sale";
ALTER TABLE "new_Sale" RENAME TO "Sale";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
