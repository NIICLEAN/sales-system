'use strict';
/**
 * Posts payments to the 9 existing AUTHORISED Xero invoices so they show as PAID.
 * Targets only payment IDs: 39, 40, 41, 42, 46, 47, 48, 49, 51
 */
const { PrismaClient } = require('../node_modules/@prisma/client');
const { XeroClient } = require('../node_modules/xero-node');

const xeroInfo = JSON.parse(process.env.XERO_INFO || '{}');
const prisma = new PrismaClient();

const TARGET_PAYMENT_IDS = [39, 40, 41, 42, 46, 47, 48, 49, 51];

(async () => {
  const conn = await prisma.xeroConnection.findFirst({ orderBy: { updatedAt: 'desc' } });
  if (!conn) { console.error('No Xero connection found'); process.exit(1); }

  const xero = new XeroClient({
    clientId: xeroInfo.id,
    clientSecret: xeroInfo.secret,
    redirectUris: [],
    scopes: []
  });
  xero.setTokenSet(conn.tokenSet);
  await xero.initialize();

  if (xero.readTokenSet().expired()) {
    console.log('Token expired, refreshing...');
    const refreshed = await xero.refreshToken();
    xero.setTokenSet(refreshed);
    await prisma.xeroConnection.update({ where: { id: conn.id }, data: { tokenSet: refreshed } });
    console.log('Token refreshed OK');
  }

  const tenantId = conn.tenantId;

  // Find bank account ID
  let accountID = process.env.XERO_PAYMENT_ACCOUNT_ID || null;
  let accountCode = process.env.XERO_PAYMENT_ACCOUNT_CODE || null;
  if (!accountID && !accountCode) {
    console.log('Looking up BANK accounts in Xero...');
    const resp = await xero.accountingApi.getAccounts(tenantId, null, 'Type=="BANK"');
    const accounts = resp.body?.accounts || [];
    if (accounts.length === 0) { console.error('No BANK accounts found in Xero.'); process.exit(1); }
    accountID = accounts[0].accountID || null;
    accountCode = accounts[0].code || null;
    console.log(`Using bank account: ${accounts[0].name} (accountID=${accountID}, code=${accountCode})`);
  }

  // Load the 9 target payments
  const payments = await prisma.$queryRaw`
    SELECT p.id, p.amount, p.method::text as method, p."xeroInvoiceId", p."createdAt"
    FROM "Payment" p
    WHERE p.id = ANY(${TARGET_PAYMENT_IDS}::int[])
    AND p."xeroInvoiceId" IS NOT NULL
    ORDER BY p.id
  `;

  console.log(`\nPosting payments for ${payments.length} invoices...\n`);

  for (const payment of payments) {
    const dateStr = new Date(payment.createdAt).toISOString().split('T')[0];
    try {
      await xero.accountingApi.createPayment(tenantId, {
        invoice: { invoiceID: payment.xeroInvoiceId },
        account: accountCode ? { code: accountCode } : { accountID: accountID },
        amount: Number(payment.amount),
        date: dateStr,
      });
      console.log(`✓ Payment ${payment.id} — £${payment.amount} (${payment.method}) → invoice ${payment.xeroInvoiceId}`);
    } catch (err) {
      const msg = err?.response?.body?.Message || err?.response?.body?.Detail || err?.message || err;
      console.error(`✗ Payment ${payment.id} failed: ${msg}`);
    }
  }

  await prisma.$disconnect();
  console.log('\nDone.');
})();
