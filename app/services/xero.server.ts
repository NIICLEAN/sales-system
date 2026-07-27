import { XeroClient, Invoice, LineAmountTypes } from "xero-node";
import prisma from "../db.server";

const scopes = [
  "openid",
  "offline_access",
  "accounting.contacts",
  "accounting.invoices",
  "accounting.payments",
  "accounting.settings",
];

// Cache bank account so we only query Xero once per process
let cachedPaymentAccount: { code?: string; accountID?: string } | null | undefined = undefined;

async function getPaymentAccount(xero: XeroClient, tenantId: string): Promise<{ code?: string; accountID?: string } | null> {
  if (process.env.XERO_PAYMENT_ACCOUNT_CODE) return { code: process.env.XERO_PAYMENT_ACCOUNT_CODE };
  if (process.env.XERO_PAYMENT_ACCOUNT_ID) return { accountID: process.env.XERO_PAYMENT_ACCOUNT_ID };
  if (cachedPaymentAccount !== undefined) return cachedPaymentAccount;
  try {
    const resp = await (xero.accountingApi as any).getAccounts(tenantId, null, 'Type=="BANK"');
    const accounts: Array<{ code?: string; accountID?: string; name?: string }> = resp?.body?.accounts || [];
    const acct = accounts[0];
    cachedPaymentAccount = acct ? { code: acct.code, accountID: acct.accountID } : null;
    console.log(`[Xero] found ${accounts.length} BANK accounts, using ${acct?.name} (code=${acct?.code}, accountID=${acct?.accountID})`);
  } catch (err: any) {
    console.warn('[Xero] could not fetch bank accounts:', err?.message);
    cachedPaymentAccount = null;
  }
  return cachedPaymentAccount;
}

export function getXeroClient() {
  return new XeroClient({
    clientId: process.env.XERO_CLIENT_ID || "",
    clientSecret: process.env.XERO_CLIENT_SECRET || "",
    redirectUris: [process.env.XERO_REDIRECT_URI || ""],
    scopes,
  });
}

export async function getXeroConnection() {
  return prisma.xeroConnection.findFirst({
    orderBy: {
      updatedAt: "desc",
    },
  });
}

export async function saveXeroConnection(tenantId: string, tokenSet: any) {
  const existing = await getXeroConnection();

  if (existing) {
    return prisma.xeroConnection.update({
      where: {
        id: existing.id,
      },
      data: {
        tenantId,
        tokenSet,
      },
    });
  }

  return prisma.xeroConnection.create({
    data: {
      tenantId,
      tokenSet,
    },
  });
}

export async function getConnectedXeroClient() {
  const connection = await getXeroConnection();

  if (!connection) {
    throw new Error("Xero is not connected yet.");
  }

  const xero = getXeroClient();

  // initialize() loads the OpenID discovery document and sets up the HTTP client.
  // Must be called before refreshToken() or any API calls.
  await xero.initialize();

  xero.setTokenSet(connection.tokenSet as any);

  if (xero.readTokenSet().expired()) {
    const refreshedTokenSet = await xero.refreshToken();

    await saveXeroConnection(connection.tenantId, refreshedTokenSet);

    xero.setTokenSet(refreshedTokenSet);
  }

  return {
    xero,
    tenantId: connection.tenantId,
  };
}

/**
 * Creates a Xero invoice for each payment on the given sale that hasn't yet
 * been sent to Xero (xeroInvoiceId IS NULL).  Safe to call multiple times —
 * already-sent payments are skipped.  Errors are caught and logged; this
 * function never throws so callers can fire-and-forget.
 */
export async function pushNewPaymentsToXero(saleId: number): Promise<void> {
  let xeroClient: Awaited<ReturnType<typeof getConnectedXeroClient>>;
  try {
    xeroClient = await getConnectedXeroClient();
  } catch (err: any) {
    console.error(`[Xero] skipping push for sale ${saleId}: ${err?.message || err}`);
    return;
  }
  const { xero, tenantId } = xeroClient;

  const sale = await prisma.sale.findUnique({
    where: { id: saleId },
    select: {
      id: true,
      customerName: true,
      customerEmail: true,
      shopifyOrderName: true,
      reference: true,
      lineItems: {
        select: { title: true, quantity: true, unitPrice: true },
        orderBy: { id: 'asc' },
      },
    },
  });
  if (!sale) return;

  // Load vatType via raw SQL to avoid schema-version crashes
  let saleVatType = "Standard";
  try {
    const rows = await prisma.$queryRaw<Array<{ vatType: string | null }>>`
      SELECT "vatType"::text FROM "Sale" WHERE id = ${saleId} LIMIT 1
    `;
    if (rows.length > 0) saleVatType = rows[0].vatType ?? "Standard";
  } catch {}

  const taxType = saleVatType === "CrossBorder" ? "ZERORATEDOUTPUT"
    : (saleVatType === "Exempt" || saleVatType === "CrossBorder") ? "EXEMPTOUTPUT"
    : "OUTPUT2";
  // Always use the configured sales account code.
  // Per Xero API docs, taxType on a line item explicitly overrides the account's default
  // tax type — so sending accountCode=205 with taxType="OUTPUT2" uses 20% VAT on Income.
  const accountCode = process.env.XERO_SALES_ACCOUNT_CODE || "205";

  // Use the Shopify order name (e.g. NCP#1638) as the base for the Xero invoice number
  const orderRef = sale.shopifyOrderName || sale.reference || `INV-${sale.id}`;

  // Build a description from the actual sale line items
  const itemsDescription = sale.lineItems.length > 0
    ? sale.lineItems.map((li) => `${li.title} x${li.quantity}`).join('\n')
    : `Invoice ${orderRef}`;

  // Load Payment records — try with xeroInvoiceId column, fall back without
  type PaymentRow = { id: number; amount: number; method: string; createdAt: Date; reference: string | null; xeroInvoiceId: string | null };
  let allPayments: PaymentRow[] = [];
  try {
    allPayments = await prisma.$queryRaw<PaymentRow[]>`
      SELECT id, amount, method::text as method, "createdAt", reference, "xeroInvoiceId"
      FROM "Payment" WHERE "saleId" = ${saleId} ORDER BY "createdAt" ASC
    `;
  } catch {
    try {
      const rows = await prisma.$queryRaw<Omit<PaymentRow, "xeroInvoiceId">[]>`
        SELECT id, amount, method::text as method, "createdAt", reference
        FROM "Payment" WHERE "saleId" = ${saleId} ORDER BY "createdAt" ASC
      `;
      allPayments = rows.map((r) => ({ ...r, xeroInvoiceId: null }));
    } catch {}
  }

  const alreadySentCount = allPayments.filter((p) => p.xeroInvoiceId).length;
  const unsentPayments = allPayments.filter((p) => !p.xeroInvoiceId);
  if (unsentPayments.length === 0) return;

  let lastXeroInvoiceId: string | null = null;

  for (let i = 0; i < unsentPayments.length; i++) {
    const payment = unsentPayments[i];
    const suffix = alreadySentCount + i + 1;

    // Atomically claim this payment before calling Xero — prevents the race between
    // the auto-push (fire-and-forget) and the manual "Send to Xero" button both
    // seeing xeroInvoiceId IS NULL and creating duplicate invoices.
    let claimed = 0;
    try {
      claimed = Number(await prisma.$executeRaw`
        UPDATE "Payment" SET "xeroInvoiceId" = 'PENDING'
        WHERE id = ${payment.id} AND "xeroInvoiceId" IS NULL
      `);
    } catch {
      console.warn(`[Xero push] could not claim payment ${payment.id} — skipping`);
      continue;
    }
    if (claimed === 0) {
      console.log(`[Xero push] payment ${payment.id} already claimed by another process — skipping`);
      continue;
    }

    const xeroReference = `${orderRef}.${suffix} - ${String(payment.method)}${payment.reference ? ` (${payment.reference})` : ''}`;
    const lineItemDescription = `${itemsDescription}\n\nPayment ${suffix}: ${String(payment.method)}${payment.reference ? ` (${payment.reference})` : ''}`;
    const dateStr = new Date(payment.createdAt).toISOString().split("T")[0];
    // EXCLUSIVE line amounts: supply net price; Xero adds VAT based on taxType.
    // This forces Xero to respect our taxType even if account 205 has a different default.
    // For OUTPUT2 (20%): net = payment / 1.2  — Xero total = net × 1.2 = original amount ✓
    // For zero-rated/exempt: net = full amount (no VAT to strip out)
    const vatMultiplier = taxType === "OUTPUT2" ? 1.2 : 1.0;
    const netAmount = Math.round((Number(payment.amount) / vatMultiplier) * 100) / 100;

    console.log(`[Xero push] sale=${saleId} payment=${payment.id} saleVatType=${saleVatType} taxType=${taxType} accountCode=${accountCode} grossAmount=${payment.amount} netAmount=${netAmount} lineAmountTypes=Exclusive`);

    try {
      const response = await (xero.accountingApi as any).createInvoices(tenantId, {
        invoices: [{
          type: Invoice.TypeEnum.ACCREC,
          contact: { name: "Shopify" },
          date: dateStr,
          dueDate: dateStr,
          lineAmountTypes: LineAmountTypes.Exclusive,
          lineItems: [{
            description: lineItemDescription,
            quantity: 1,
            unitAmount: netAmount,
            taxType,
            accountCode,
          }],
          reference: xeroReference,
          invoiceNumber: `INV-${saleId}.${suffix}`,
          status: Invoice.StatusEnum.AUTHORISED,
        }],
      });

      const newXeroInvoiceId: string | undefined = response.body?.invoices?.[0]?.invoiceID;
      const validationErrors = response.body?.invoices?.[0]?.validationErrors || [];
      const returnedLineItem = response.body?.invoices?.[0]?.lineItems?.[0];

      console.log(`[Xero push] response for ref=${xeroReference}: invoiceID=${newXeroInvoiceId} returnedTaxType=${returnedLineItem?.taxType} returnedTaxAmount=${returnedLineItem?.taxAmount} returnedAccountCode=${returnedLineItem?.accountCode} lineAmountTypes=${response.body?.invoices?.[0]?.lineAmountTypes}`);

      if (validationErrors.length > 0) {
        console.warn(`Xero validation errors for ref=${xeroReference}:`, validationErrors.map((e: any) => e.message).join("; "));
        continue;
      }

      if (newXeroInvoiceId) {
        // Post a payment so the invoice shows as PAID in Xero
        try {
          const paymentAccount = await getPaymentAccount(xero, tenantId);
          if (paymentAccount) {
            await (xero.accountingApi as any).createPayment(tenantId, {
              invoice: { invoiceID: newXeroInvoiceId },
              account: paymentAccount.code ? { code: paymentAccount.code } : { accountID: paymentAccount.accountID },
              amount: Number(payment.amount),
              date: dateStr,
            });
            console.log(`[Xero push] payment posted for invoice ${newXeroInvoiceId} via account ${paymentAccount.code || paymentAccount.accountID}`);
          } else {
            console.warn(`[Xero push] no bank account found — invoice ${newXeroInvoiceId} left as Awaiting Payment. Set XERO_PAYMENT_ACCOUNT_CODE or XERO_PAYMENT_ACCOUNT_ID env var to fix.`);
          }
        } catch (payErr: any) {
          console.warn(`[Xero push] payment failed for invoice ${newXeroInvoiceId}:`, payErr?.response?.body?.Message || payErr?.message);
        }

        try {
          await prisma.$executeRaw`UPDATE "Payment" SET "xeroInvoiceId" = ${newXeroInvoiceId} WHERE id = ${payment.id}`;
        } catch {
          console.warn(`Could not save xeroInvoiceId for payment ${payment.id}`);
        }
        lastXeroInvoiceId = newXeroInvoiceId;
      }
    } catch (err: any) {
      // Clear the PENDING claim so the payment can be retried
      try {
        await prisma.$executeRaw`UPDATE "Payment" SET "xeroInvoiceId" = NULL WHERE id = ${payment.id} AND "xeroInvoiceId" = 'PENDING'`;
      } catch {}
      console.error(`Auto Xero push failed for sale=${saleId} payment=${payment.id}:`, err?.response?.body?.Detail || err?.message || err);
    }
  }

  if (lastXeroInvoiceId) {
    try {
      await prisma.$executeRaw`UPDATE "Sale" SET "xeroInvoiceId" = ${lastXeroInvoiceId} WHERE id = ${saleId}`;
    } catch {}
  }
}