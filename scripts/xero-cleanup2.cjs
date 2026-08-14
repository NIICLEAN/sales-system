'use strict';
/**
 * Xero Cleanup v2
 *
 * Strategy:
 *  1. Get the 8 canonical xeroInvoiceIds from our DB (these are the ones to KEEP)
 *  2. Fetch all AUTHORISED invoices from Xero dated today using a where clause
 *  3. Among those, find any with our reference pattern (NCP#... - Method) NOT in the keep list
 *  4. Void those orphans
 *  5. Print final state
 */

const { PrismaClient } = require('../node_modules/@prisma/client');
const { XeroClient } = require('../node_modules/xero-node');

const xeroInfo = JSON.parse(process.env.XERO_INFO || '{}');
const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

async function getAllTodayInvoices(xero, tenantId) {
  const today = new Date();
  const y = today.getUTCFullYear();
  // Use a broad enough range to catch BST/UTC edge: yesterday through tomorrow UTC
  const where = `Date >= DateTime(${y},07,23) AND Date <= DateTime(${y},07,25) AND Status == "AUTHORISED"`;

  let all = [];
  for (let page = 1; page <= 10; page++) {
    const resp = await xero.accountingApi.getInvoices(
      tenantId,
      null,  // ifModifiedSince
      where, // where
      'Date DESC', // order — newest first
      null, null, null, null,
      page,  // page
      false  // includeArchived
    );
    const invoices = (resp.body && resp.body.invoices) || [];
    all = all.concat(invoices);
    if (invoices.length < 100) break; // no more pages
  }
  return all;
}

(async () => {
  // ── Connect ───────────────────────────────────────────────────────────────────
  const conn = await prisma.xeroConnection.findFirst({ orderBy: { updatedAt: 'desc' } });
  if (!conn) { console.error('No Xero connection'); process.exit(1); }

  const xero = new XeroClient({ clientId: xeroInfo.id, clientSecret: xeroInfo.secret, redirectUris: [], scopes: [] });
  xero.setTokenSet(conn.tokenSet);
  await xero.initialize();
  if (xero.readTokenSet().expired()) {
    const t = await xero.refreshToken(); xero.setTokenSet(t);
    await prisma.xeroConnection.updateMany({ data: { tokenSet: t } });
    console.log('Token refreshed');
  }
  const tenantId = conn.tenantId;

  // ── Step 1: DB keep list ──────────────────────────────────────────────────────
  const dbPayments = await prisma.$queryRaw`
    SELECT p.id as "paymentId", p."saleId", p."xeroInvoiceId", s."shopifyOrderName"
    FROM "Payment" p JOIN "Sale" s ON s.id = p."saleId"
    WHERE p."xeroInvoiceId" IS NOT NULL ORDER BY p.id
  `;
  const keepIds = new Set(dbPayments.map(r => r.xeroInvoiceId));
  console.log(`DB keep list (${keepIds.size} invoices):`);
  for (const r of dbPayments) {
    console.log(`  ${r.shopifyOrderName} → ${r.xeroInvoiceId}`);
  }

  // ── Step 2: Fetch today's invoices from Xero ──────────────────────────────────
  console.log('\nFetching today\'s AUTHORISED invoices from Xero...');
  const todayInvoices = await getAllTodayInvoices(xero, tenantId);
  console.log(`Fetched ${todayInvoices.length} invoices dated around today`);

  // ── Step 3: Filter to ours (reference has " - ", contact not "Shopify") ────────
  const ours = todayInvoices.filter(inv => {
    const ref = inv.reference || '';
    const contact = (inv.contact && inv.contact.name) || '';
    return / - /.test(ref) && contact !== 'Shopify';
  });
  console.log(`\nOf those, ${ours.length} match our pattern (ref has " - ", contact ≠ Shopify):`);
  for (const inv of ours) {
    const inDb = keepIds.has(inv.invoiceID) ? '✓ KEEP' : '✗ ORPHAN';
    console.log(`  [${inDb}] ${inv.invoiceNumber || inv.invoiceID} | ref: ${inv.reference} | contact: ${inv.contact && inv.contact.name} | £${inv.total}`);
  }

  // ── Step 4: Void orphans ──────────────────────────────────────────────────────
  const orphans = ours.filter(inv => !keepIds.has(inv.invoiceID));
  if (orphans.length === 0) {
    console.log('\nNo orphans to void — Xero is already clean!');
  } else {
    console.log(`\nVoiding ${orphans.length} orphaned invoices...`);
    for (const inv of orphans) {
      console.log(`  Voiding ${inv.invoiceNumber || inv.invoiceID} (${inv.reference})...`);
      try {
        await xero.accountingApi.updateInvoice(tenantId, inv.invoiceID, {
          invoices: [{ invoiceID: inv.invoiceID, status: 'VOIDED' }]
        });
        console.log(`    ✓ Voided`);
      } catch (err) {
        const msg = err.response && err.response.body && err.response.body.Message
          ? err.response.body.Message
          : err.message || String(err);
        console.error(`    ✗ Failed: ${msg}`);
      }
    }
  }

  // ── Step 5: Summary of kept invoices ─────────────────────────────────────────
  const kept = ours.filter(inv => keepIds.has(inv.invoiceID));
  console.log(`\n── Clean state (${kept.length} kept invoices) ────────────────────────`);
  for (const inv of kept) {
    console.log(`  ${inv.invoiceNumber} | ${inv.reference} | ${inv.contact && inv.contact.name} | £${inv.total} | ${inv.status}`);
  }

  console.log('\nDone.');
  await prisma.$disconnect();
})().catch(err => {
  console.error('Fatal:', err.message || err);
  process.exit(1);
});
