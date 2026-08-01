'use strict';
const { XeroClient } = require('../node_modules/xero-node');
const { PrismaClient } = require('../node_modules/@prisma/client');

const xeroInfo = JSON.parse(process.env.XERO_INFO || '{}');
const prisma = new PrismaClient();

(async () => {
  const conn = await prisma.xeroConnection.findFirst({ orderBy: { updatedAt: 'desc' } });
  if (!conn) { console.error('No Xero connection'); process.exit(1); }
  await prisma.$disconnect();

  const xero = new XeroClient({ clientId: xeroInfo.id, clientSecret: xeroInfo.secret, redirectUris: [], scopes: [] });
  xero.setTokenSet(conn.tokenSet);
  await xero.initialize();
  if (xero.readTokenSet().expired()) { xero.setTokenSet(await xero.refreshToken()); }
  const tenantId = conn.tenantId;

  // Fetch all sales invoices (ACCREC type) up to 200 — use where clause, not statuses param
  const resp = await xero.accountingApi.getInvoices(
    tenantId, undefined, 'Type=="ACCREC"', undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, 200
  );
  const all = (resp.body?.invoices || []).filter(i => i.reference && i.reference.includes(' - '));

  console.log(`\nTotal invoices with " - " in reference: ${all.length}\n`);

  // Group by reference
  const byRef = {};
  for (const inv of all) {
    const ref = inv.reference;
    if (!byRef[ref]) byRef[ref] = [];
    byRef[ref].push(inv);
  }

  let dupeCount = 0;
  const dupeIds = [];

  for (const [ref, invs] of Object.entries(byRef).sort()) {
    if (invs.length > 1) {
      dupeCount++;
      console.log(`DUPLICATE (${invs.length}x): ${ref}`);
      for (const inv of invs) {
        const keep = inv.status === 'PAID';
        console.log(`  [${keep ? 'KEEP ' : 'VOID '}] ${inv.invoiceNumber || inv.invoiceID} | ${inv.status} | £${inv.total} | contact: ${inv.contact?.name} | id: ${inv.invoiceID}`);
        if (!keep) dupeIds.push(inv.invoiceID);
      }
    } else {
      console.log(`OK: ${ref} | ${invs[0].status} | £${invs[0].total} | ${invs[0].contact?.name}`);
    }
  }

  if (dupeCount === 0) {
    console.log('No duplicates found.');
    return;
  }

  console.log(`\nFound ${dupeCount} duplicate groups. ${dupeIds.length} invoices to void.`);
  if (process.argv[2] === '--void') {
    console.log('\nVoiding duplicates...');
    for (const id of dupeIds) {
      try {
        await xero.accountingApi.updateInvoice(tenantId, id, { invoices: [{ invoiceID: id, status: 'VOIDED' }] });
        console.log(`  Voided ${id}`);
      } catch (err) {
        console.error(`  Failed to void ${id}:`, err?.response?.body?.Message || err?.message);
      }
    }
    console.log('Done.');
  } else {
    console.log('\nRun with --void to void the non-PAID duplicates.');
  }
})();
