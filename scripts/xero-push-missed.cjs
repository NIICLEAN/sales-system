'use strict';
/**
 * One-off script: find every Payment that never made it to Xero
 * (xeroInvoiceId IS NULL or stuck as 'PENDING') and push them now.
 *
 * Usage:
 *   DATABASE_URL="..." XERO_INFO='{"id":"...","secret":"..."}' node scripts/xero-push-missed.cjs
 *
 * Or on Railway: open the service shell and run the command above with
 * the production DATABASE_URL and XERO_INFO values from the env tab.
 */

const { PrismaClient } = require('../node_modules/@prisma/client');
const { XeroClient } = require('../node_modules/xero-node');

const xeroInfo = JSON.parse(process.env.XERO_INFO || '{}');
const prisma = new PrismaClient();

const ACCOUNT_CODE = process.env.XERO_SALES_ACCOUNT_CODE || '205';

(async () => {
  // ── 1. Connect to Xero ────────────────────────────────────────────────────
  const conn = await prisma.xeroConnection.findFirst({ orderBy: { updatedAt: 'desc' } });
  if (!conn) { console.error('No Xero connection found in DB'); process.exit(1); }

  const xero = new XeroClient({
    clientId: xeroInfo.id || process.env.XERO_CLIENT_ID,
    clientSecret: xeroInfo.secret || process.env.XERO_CLIENT_SECRET,
    redirectUris: [],
    scopes: []
  });
  xero.setTokenSet(conn.tokenSet);
  await xero.initialize();

  let finalTokenSet = conn.tokenSet;
  if (xero.readTokenSet().expired()) {
    console.log('Token expired — refreshing...');
    finalTokenSet = await xero.refreshToken();
    xero.setTokenSet(finalTokenSet);
    console.log('Token refreshed OK');
  } else {
    console.log('Token still valid');
  }
  const tenantId = conn.tenantId;

  // ── 2. Reset stuck PENDING records (older than 10 min) ───────────────────
  const stuckReset = await prisma.$executeRaw`
    UPDATE "Payment"
    SET "xeroInvoiceId" = NULL
    WHERE "xeroInvoiceId" = 'PENDING'
      AND "createdAt" < NOW() - INTERVAL '10 minutes'
  `;
  if (stuckReset > 0) console.log(`Reset ${stuckReset} stuck PENDING payment(s) to NULL`);

  // ── 3. Find all sales that have at least one unpushed payment ─────────────
  const unpushedSaleRows = await prisma.$queryRaw`
    SELECT DISTINCT "saleId"
    FROM "Payment"
    WHERE "xeroInvoiceId" IS NULL
    ORDER BY "saleId" ASC
  `;
  const saleIds = unpushedSaleRows.map(r => r.saleId);
  console.log(`Found ${saleIds.length} sale(s) with unpushed payments: [${saleIds.join(', ')}]`);

  if (saleIds.length === 0) {
    console.log('Nothing to push.');
    await prisma.$disconnect();
    return;
  }

  // ── 4. Push each sale ─────────────────────────────────────────────────────
  for (const saleId of saleIds) {
    const sale = await prisma.sale.findUnique({
      where: { id: saleId },
      select: {
        id: true, customerName: true, shopifyOrderName: true, reference: true,
        lineItems: { select: { title: true, quantity: true }, orderBy: { id: 'asc' } }
      }
    });
    if (!sale) { console.error(`  Sale ${saleId} not found — skipping`); continue; }

    // Determine VAT type
    let vatType = 'Standard';
    try {
      const rows = await prisma.$queryRaw`SELECT "vatType"::text FROM "Sale" WHERE id = ${saleId} LIMIT 1`;
      if (rows.length > 0) vatType = rows[0].vatType ?? 'Standard';
    } catch {}
    const taxType = vatType === 'CrossBorder' ? 'ZERORATEDOUTPUT'
      : (vatType === 'Exempt') ? 'EXEMPTOUTPUT'
      : 'OUTPUT2';

    const orderRef = sale.shopifyOrderName || sale.reference || ('INV-' + saleId);
    const itemsDescription = sale.lineItems.length > 0
      ? sale.lineItems.map(li => li.title + ' x' + li.quantity).join('\n')
      : ('Invoice ' + orderRef);

    // Load all payments for this sale
    const allPayments = await prisma.$queryRaw`
      SELECT id, amount, method::text as method, "createdAt", reference, "xeroInvoiceId"
      FROM "Payment" WHERE "saleId" = ${saleId} ORDER BY "createdAt" ASC
    `;

    const alreadySentCount = allPayments.filter(p => p.xeroInvoiceId && p.xeroInvoiceId !== 'PENDING').length;
    const unpushed = allPayments.filter(p => !p.xeroInvoiceId);

    console.log(`\nSale ${saleId} (${sale.customerName}) [${orderRef}]: ${allPayments.length} total, ${alreadySentCount} already sent, ${unpushed.length} to push`);

    for (let i = 0; i < unpushed.length; i++) {
      const payment = unpushed[i];
      const suffix = alreadySentCount + i + 1;

      // Atomically claim to prevent double-push
      const claimed = Number(await prisma.$executeRaw`
        UPDATE "Payment" SET "xeroInvoiceId" = 'PENDING'
        WHERE id = ${payment.id} AND "xeroInvoiceId" IS NULL
      `);
      if (claimed === 0) {
        console.log(`  Payment ${payment.id} already claimed by another process — skipping`);
        continue;
      }

      const xeroReference = `${orderRef}.${suffix} - ${payment.method}${payment.reference ? ' (' + payment.reference + ')' : ''}`;
      const lineItemDescription = itemsDescription + `\n\nPayment ${suffix}: ${payment.method}${payment.reference ? ' (' + payment.reference + ')' : ''}`;
      const vatMultiplier = taxType === 'OUTPUT2' ? 1.2 : 1.0;
      const netAmount = Math.round((Number(payment.amount) / vatMultiplier) * 100) / 100;
      const dateStr = new Date(payment.createdAt).toISOString().split('T')[0];
      const invoiceNumber = `INV-${saleId}.${suffix}`;

      console.log(`  Pushing payment ${suffix}: ref=${xeroReference}, amount=£${payment.amount}, net=£${netAmount}, date=${dateStr}`);

      try {
        const response = await xero.accountingApi.createInvoices(tenantId, {
          invoices: [{
            type: 'ACCREC',
            contact: { name: sale.customerName || 'Customer' },
            date: dateStr,
            dueDate: dateStr,
            invoiceNumber,
            lineAmountTypes: 'Exclusive',
            lineItems: [{
              description: lineItemDescription,
              quantity: 1,
              unitAmount: netAmount,
              taxType,
              accountCode: ACCOUNT_CODE
            }],
            reference: xeroReference,
            status: 'AUTHORISED'
          }]
        });

        const inv = response.body?.invoices?.[0];
        const errors = inv?.validationErrors || [];
        if (errors.length > 0) {
          console.error(`  Validation errors:`, JSON.stringify(errors));
          // Release PENDING claim so it can be retried
          await prisma.$executeRaw`UPDATE "Payment" SET "xeroInvoiceId" = NULL WHERE id = ${payment.id} AND "xeroInvoiceId" = 'PENDING'`;
          continue;
        }

        const newId = inv?.invoiceID;
        if (newId) {
          await prisma.$executeRaw`UPDATE "Payment" SET "xeroInvoiceId" = ${newId} WHERE id = ${payment.id}`;
          await prisma.$executeRaw`UPDATE "Sale" SET "xeroInvoiceId" = ${newId} WHERE id = ${saleId}`;
          console.log(`  ✓ Created Xero invoice ${newId} (${invoiceNumber})`);
        } else {
          console.error(`  No invoiceID in response — releasing PENDING`);
          await prisma.$executeRaw`UPDATE "Payment" SET "xeroInvoiceId" = NULL WHERE id = ${payment.id} AND "xeroInvoiceId" = 'PENDING'`;
        }
      } catch (err) {
        console.error(`  Error:`, err.message || err);
        if (err.response?.body) console.error(`  Xero response:`, JSON.stringify(err.response.body));
        // Release PENDING claim so it can be retried
        await prisma.$executeRaw`UPDATE "Payment" SET "xeroInvoiceId" = NULL WHERE id = ${payment.id} AND "xeroInvoiceId" = 'PENDING'`;
      }
    }
  }

  // ── 5. Save refreshed token ───────────────────────────────────────────────
  if (finalTokenSet !== conn.tokenSet) {
    await prisma.xeroConnection.updateMany({ data: { tokenSet: finalTokenSet } });
    console.log('\nRefreshed token saved to DB');
  }

  await prisma.$disconnect();
  console.log('\nDone.');
})().catch(e => {
  console.error('Fatal:', e.message || e);
  prisma.$disconnect();
  process.exit(1);
});
