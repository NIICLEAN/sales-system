'use strict';
/**
 * Xero Cleanup Script
 *
 * 1. Loads all xeroInvoiceId values from our DB (these are the "correct" invoices to KEEP)
 * 2. Fetches all AUTHORISED invoices from Xero created today that have our reference pattern
 *    (Reference contains " - " and contact is not "Shopify")
 * 3. Voids any invoice NOT in our keep list
 * 4. Reports the final clean state
 */

const { PrismaClient } = require('../node_modules/@prisma/client');
const { XeroClient } = require('../node_modules/xero-node');

const xeroInfo = JSON.parse(process.env.XERO_INFO || '{}');
const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

(async () => {
  // ── Connect to Xero ──────────────────────────────────────────────────────────
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
    await prisma.xeroConnection.updateMany({ data: { tokenSet: refreshed } });
    console.log('Token refreshed');
  } else {
    console.log('Token valid');
  }

  const tenantId = conn.tenantId;

  // ── Step 1: Load our DB's canonical xeroInvoiceId set ────────────────────────
  const dbPayments = await prisma.$queryRaw`
    SELECT p.id as "paymentId", p."saleId", p."xeroInvoiceId", s."shopifyOrderName"
    FROM "Payment" p
    JOIN "Sale" s ON s.id = p."saleId"
    WHERE p."xeroInvoiceId" IS NOT NULL
    ORDER BY p.id
  `;

  const keepIds = new Set(dbPayments.map(r => r.xeroInvoiceId));
  console.log(`\nDB has ${keepIds.size} canonical Xero invoice IDs:`);
  for (const r of dbPayments) {
    console.log(`  Payment ${r.paymentId} (Sale ${r.saleId} / ${r.shopifyOrderName}) → ${r.xeroInvoiceId}`);
  }

  // ── Step 2: Fetch AUTHORISED invoices from Xero dated TODAY only ─────────────
  const todayStr = new Date().toISOString().split('T')[0]; // e.g. 2026-07-24

  console.log(`\nFetching AUTHORISED invoices from Xero dated ${todayStr} only...`);

  let allInvoices = [];
  try {
    const resp = await xero.accountingApi.getInvoices(
      tenantId,
      null, // modifiedAfter
      null, // where filter
      null, // order
      null, // IDs
      null, // invoiceNumbers
      null, // contactIDs
      ['AUTHORISED'], // statuses
      1,    // page
      false // includeArchived
    );
    allInvoices = (resp.body && resp.body.invoices) || [];
    console.log(`Fetched ${allInvoices.length} AUTHORISED invoices (page 1)`);

    // Get page 2 if needed
    if (allInvoices.length === 100) {
      const resp2 = await xero.accountingApi.getInvoices(
        tenantId, null, null, null, null, null, null, ['AUTHORISED'], 2, false
      );
      const page2 = (resp2.body && resp2.body.invoices) || [];
      allInvoices = allInvoices.concat(page2);
      console.log(`Fetched ${page2.length} more on page 2, total: ${allInvoices.length}`);
    }
  } catch (err) {
    console.error('Failed to fetch invoices:', err.message || err);
    process.exit(1);
  }

  // ── Step 3: Filter to today's invoices matching our pattern ──────────────────
  // Our invoices: reference contains " - " (NCP#xxxx.n - Method) AND contact != "Shopify"
  // AND invoice date is today (guards against touching any historical invoices)
  const ourPattern = / - /;
  const ourInvoices = allInvoices.filter(inv => {
    const ref = inv.reference || '';
    const contactName = (inv.contact && inv.contact.name) || '';
    // Use dateString (e.g. "2026-07-24T00:00:00") not the Date object (which is UTC and shifts by timezone)
    const invDate = (inv.dateString || '').split('T')[0];
    return ourPattern.test(ref) && contactName !== 'Shopify' && invDate === todayStr;
  });

  console.log(`\nFound ${ourInvoices.length} invoices matching our pattern (contact ≠ Shopify, reference has " - ")`);

  // ── Step 4: Identify orphans (our pattern but NOT in our keep list) ───────────
  const toVoid = ourInvoices.filter(inv => !keepIds.has(inv.invoiceID));
  const toKeep = ourInvoices.filter(inv => keepIds.has(inv.invoiceID));

  console.log(`  KEEP: ${toKeep.length} (in DB)`);
  console.log(`  VOID: ${toVoid.length} (orphaned duplicates)`);

  if (toVoid.length === 0) {
    console.log('\nNo orphaned invoices to void. Xero is clean!');
  } else {
    console.log('\nVoiding orphaned invoices:');
    for (const inv of toVoid) {
      const ref = inv.reference || '(no ref)';
      const contact = (inv.contact && inv.contact.name) || '(no contact)';
      const amount = inv.total || 0;
      console.log(`  Voiding ${inv.invoiceNumber || inv.invoiceID} | ref: ${ref} | contact: ${contact} | £${amount}`);
      try {
        await xero.accountingApi.updateInvoice(tenantId, inv.invoiceID, {
          invoices: [{ invoiceID: inv.invoiceID, status: 'VOIDED' }]
        });
        console.log(`    ✓ Voided`);
      } catch (err) {
        console.error(`    ✗ Failed: ${err.message || JSON.stringify(err.response && err.response.body)}`);
      }
    }
  }

  // ── Step 5: Report final state ────────────────────────────────────────────────
  console.log('\n── Final state (kept invoices) ──────────────────────────────────');
  for (const inv of toKeep) {
    const ref = inv.reference || '(no ref)';
    const contact = (inv.contact && inv.contact.name) || '(no contact)';
    console.log(`  ${inv.invoiceNumber || inv.invoiceID} | ref: ${ref} | contact: ${contact} | £${inv.total} | ${inv.status}`);
  }

  console.log('\nDone.');
  await prisma.$disconnect();
})().catch(err => {
  console.error('Fatal:', err.message || err);
  process.exit(1);
});
