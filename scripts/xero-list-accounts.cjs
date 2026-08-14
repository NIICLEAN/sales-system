'use strict';
const { XeroClient } = require('../node_modules/xero-node');

const xeroInfo = JSON.parse(process.env.XERO_INFO || '{}');

(async () => {
  const xero = new XeroClient({ clientId: xeroInfo.id, clientSecret: xeroInfo.secret, redirectUris: [], scopes: [] });
  const { PrismaClient } = require('../node_modules/@prisma/client');
  const prisma = new PrismaClient();
  const conn = await prisma.xeroConnection.findFirst({ orderBy: { updatedAt: 'desc' } });
  await prisma.$disconnect();
  xero.setTokenSet(conn.tokenSet);
  await xero.initialize();
  if (xero.readTokenSet().expired()) xero.setTokenSet(await xero.refreshToken());
  const tenantId = conn.tenantId;

  // List bank/payment accounts
  const resp = await xero.accountingApi.getAccounts(tenantId, undefined, 'Type=="BANK" OR Type=="CURRENT"');
  const accounts = resp.body.accounts || [];
  console.log('\n=== BANK/PAYMENT ACCOUNTS ===');
  for (const a of accounts) {
    console.log(`  ${a.code} | ${a.name} | ${a.type} | ID: ${a.accountID}`);
  }

  // Also list all AWAITING invoices with NCP# references so we can see the duplicates
  const invResp = await xero.accountingApi.getInvoices(tenantId, undefined, 'Status=="AUTHORISED"', undefined, undefined, undefined, undefined, ['ACCREC'], undefined, undefined, undefined, 200);
  const invoices = (invResp.body.invoices || []).filter(inv => inv.reference && inv.reference.includes('NCP#'));
  console.log('\n=== OUR AWAITING INVOICES (with NCP# reference) ===');
  for (const inv of invoices.sort((a, b) => (a.reference || '').localeCompare(b.reference || ''))) {
    console.log(`  ${inv.invoiceNumber} | ref: ${inv.reference} | to: ${inv.contact?.name} | £${inv.total} | ${inv.invoiceID}`);
  }
})();
