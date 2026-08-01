'use strict';
const { PrismaClient } = require('../node_modules/@prisma/client');
const { XeroClient } = require('../node_modules/xero-node');

const xeroInfo = JSON.parse(process.env.XERO_INFO || '{}');
const prisma = new PrismaClient();

(async () => {
  const conn = await prisma.xeroConnection.findFirst({ orderBy: { updatedAt: 'desc' } });
  if (!conn) { console.error('No Xero connection found'); process.exit(1); }
  console.log('tenantId:', conn.tenantId);

  const xero = new XeroClient({
    clientId: xeroInfo.id,
    clientSecret: xeroInfo.secret,
    redirectUris: [],
    scopes: []
  });
  xero.setTokenSet(conn.tokenSet);

  // Initialize OpenID client (needed for token refresh)
  await xero.initialize();

  let finalTokenSet = conn.tokenSet;
  if (xero.readTokenSet().expired()) {
    console.log('Token expired, refreshing...');
    finalTokenSet = await xero.refreshToken();
    xero.setTokenSet(finalTokenSet);
    console.log('Token refreshed OK');
  } else {
    console.log('Token still valid, no refresh needed');
  }
  const tenantId = conn.tenantId;

  for (const saleId of [136, 137, 138, 139, 144, 61, 145, 146]) {
    const sale = await prisma.sale.findUnique({
      where: { id: saleId },
      select: {
        id: true, customerName: true, customerEmail: true, shopifyOrderName: true, reference: true,
        lineItems: { select: { title: true, quantity: true }, orderBy: { id: 'asc' } }
      }
    });
    if (!sale) { console.error('Sale not found:', saleId); continue; }

    const accountCode = '205';
    const taxType = 'OUTPUT2';
    const vatMultiplier = 1.2;
    // Use Shopify order name (e.g. NCP#1638) as the base for invoice number and reference
    const orderRef = sale.shopifyOrderName || sale.reference || ('INV-' + saleId);

    // Build items description from sale line items
    const itemsDescription = sale.lineItems.length > 0
      ? sale.lineItems.map(li => li.title + ' x' + li.quantity).join('\n')
      : ('Invoice ' + orderRef);

    const payments = await prisma.$queryRawUnsafe(
      `SELECT id, amount, method::text as method, "createdAt", reference, "xeroInvoiceId" FROM "Payment" WHERE "saleId" = $1 ORDER BY "createdAt" ASC`,
      saleId
    );

    console.log(`Sale ${saleId} (${sale.customerName}) [${orderRef}]: ${payments.length} payments`);

    // Void any already-pushed Xero invoices so we can recreate with the correct format
    for (const payment of payments) {
      if (payment.xeroInvoiceId) {
        try {
          await xero.accountingApi.updateInvoice(tenantId, payment.xeroInvoiceId, {
            invoices: [{ invoiceID: payment.xeroInvoiceId, status: 'VOIDED' }]
          });
          console.log(`  Voided Xero invoice ${payment.xeroInvoiceId} for payment ${payment.id}`);
        } catch (err) {
          console.warn(`  Could not void ${payment.xeroInvoiceId}:`, err.message || err);
        }
        await prisma.$executeRawUnsafe('UPDATE "Payment" SET "xeroInvoiceId" = NULL WHERE id = $1', payment.id);
        payment.xeroInvoiceId = null;
      }
    }

    for (let i = 0; i < payments.length; i++) {
      const payment = payments[i];
      const suffix = i + 1;
      const xeroReference = orderRef + '.' + suffix + ' - ' + payment.method + (payment.reference ? ' (' + payment.reference + ')' : '');
      const lineItemDescription = itemsDescription + '\n\nPayment ' + suffix + ': ' + payment.method + (payment.reference ? ' (' + payment.reference + ')' : '');
      const netAmount = Math.round((Number(payment.amount) / vatMultiplier) * 100) / 100;
      const dateStr = new Date(payment.createdAt).toISOString().split('T')[0];
      console.log(`  Pushing payment ${suffix} (ref: ${xeroReference}): amount=${payment.amount}, net=${netAmount}, date=${dateStr}`);

      try {
        const response = await xero.accountingApi.createInvoices(tenantId, {
          invoices: [{
            type: 'ACCREC',
            contact: { name: 'Shopify' },
            date: dateStr,
            dueDate: dateStr,
            lineAmountTypes: 'Exclusive',
            lineItems: [{
              description: lineItemDescription,
              quantity: 1,
              unitAmount: netAmount,
              taxType: taxType,
              accountCode: accountCode
            }],
            reference: xeroReference,
            // invoiceNumber omitted — let Xero auto-assign. NCP#.n is in the reference.
            status: 'AUTHORISED'
          }]
        });

        const inv = response.body && response.body.invoices && response.body.invoices[0];
        const errors = (inv && inv.validationErrors) || [];
        if (errors.length > 0) {
          console.error('  Validation errors:', JSON.stringify(errors));
          continue;
        }
        const newId = inv && inv.invoiceID;
        console.log(`  Created Xero invoice ${newId} (ref: ${xeroReference})`);
        if (newId) {
          await prisma.$executeRawUnsafe('UPDATE "Payment" SET "xeroInvoiceId" = $1 WHERE id = $2', newId, payment.id);
          await prisma.$executeRawUnsafe('UPDATE "Sale" SET "xeroInvoiceId" = $1 WHERE id = $2', newId, saleId);
          console.log(`  Marked payment ${payment.id} with xeroInvoiceId`);
        }
      } catch (err) {
        console.error(`  Error pushing ref=${xeroReference}:`, err.message || err);
        if (err.response && err.response.body) {
          console.error('  Xero response:', JSON.stringify(err.response.body));
        }
      }
    }
  }

  // Save refreshed token back to DB (only if it changed)
  if (finalTokenSet !== conn.tokenSet) {
    await prisma.xeroConnection.updateMany({ data: { tokenSet: finalTokenSet } });
    console.log('Refreshed token saved');
  }
  await prisma.$disconnect();
  console.log('Done');
})().catch(e => {
  console.error('Fatal:', e.message || e);
  prisma.$disconnect();
  process.exit(1);
});
