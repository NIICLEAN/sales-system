import { useEffect } from "react";
import { Form, redirect, useLoaderData, useSearchParams } from "react-router";
import { Banner } from "@shopify/polaris";
import { Invoice, LineAmountTypes } from "xero-node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getConnectedXeroClient } from "../services/xero.server";
import { getInvoiceDiscountMeta } from "../services/invoiceDiscountMeta.server";
import { getSaleShippingMeta, upsertSaleShippingMeta } from "../services/saleShippingMeta.server";
import { generateShippingLabel } from "../services/shippingLabel.server";
import { deleteInvoiceWithRelations } from "../services/deleteInvoice.server";

const VAT_RATE = 0.2;

function getGrossPrice(netPrice: number, isVatExempt: boolean) {
  return isVatExempt ? netPrice : Math.round(netPrice * (1 + VAT_RATE) * 100) / 100;
}

function money(value: any) {
  return `£${Number(value ?? 0).toFixed(2)}`;
}

function formatDateTime(value: string | Date) {
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "Europe/London",
  }).format(new Date(value));
}

function formatDate(value: string | Date) {
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "short",
    timeZone: "Europe/London",
  }).format(new Date(value));
}

function withEmbeddedParamsFromRequest(request: Request, path: string) {
  const requestUrl = new URL(request.url);
  const [pathname, queryString = ""] = path.split("?");
  const nextParams = new URLSearchParams(queryString);

  for (const key of ["shop", "host", "embedded", "id_token"]) {
    const value = requestUrl.searchParams.get(key);
    if (value && !nextParams.has(key)) {
      nextParams.set(key, value);
    }
  }

  const nextQuery = nextParams.toString();
  return nextQuery ? `${pathname}?${nextQuery}` : pathname;
}

export async function action({ request, params }: { request: Request; params: { invoiceId: string } }) {
  const { admin } = await authenticate.admin(request);

  const formData = await request.formData();
  const intent = String(formData.get("_intent") || "").trim();
  const invoiceId = Number(params.invoiceId || 0);

  if (!invoiceId) {
    return null;
  }

  if (intent === "deleteInvoice") {
    try {
      await deleteInvoiceWithRelations(invoiceId);
      return redirect(
        withEmbeddedParamsFromRequest(
          request,
          `/app/invoices?syncStatus=success&syncMessage=${encodeURIComponent(`Deleted invoice INV-${invoiceId}`)}`,
        ),
      );
    } catch (error: any) {
      console.error("Delete invoice failed:", error);
      return redirect(
        withEmbeddedParamsFromRequest(
          request,
          `/app/invoices/${invoiceId}?labelStatus=error&labelMessage=${encodeURIComponent(String(error?.message || "Failed to delete invoice"))}`,
        ),
      );
    }
  }

  if (intent === "generateNcpNumber") {
    try {
      const sale = await prisma.sale.findUnique({
        where: { id: invoiceId },
        select: {
          id: true,
          shopifyOrderId: true,
          customerId: true,
          customerName: true,
          customerEmail: true,
          customerVatNumber: true,
          customerPhone: true,
          reference: true,
          paymentMethod: true,
          paymentStatus: true,
          amountPaid: true,
          lineItems: {
            select: {
              shopifyVariantId: true,
              title: true,
              sku: true,
              quantity: true,
              unitPrice: true,
              discount: true,
              isCustom: true,
            },
          },
        },
      });

      if (!sale) {
        console.error(`generateNcpNumber: Invoice ${invoiceId} not found`);
        return redirect(withEmbeddedParamsFromRequest(request, `/app/invoices/${invoiceId}?labelStatus=error&labelMessage=${encodeURIComponent("Invoice not found")}`));
      }

      if (sale.shopifyOrderId) {
        console.info(`generateNcpNumber: Invoice ${invoiceId} already has NCP ${sale.shopifyOrderId}`);
        return redirect(withEmbeddedParamsFromRequest(request, `/app/invoices/${invoiceId}?labelStatus=error&labelMessage=${encodeURIComponent("This invoice already has an NCP number")}`));
      }

      if (String(sale.paymentStatus || "").toLowerCase() !== "paid") {
        console.info(`generateNcpNumber: Invoice ${invoiceId} payment status is "${sale.paymentStatus}", not "paid"`);
        return redirect(withEmbeddedParamsFromRequest(request, `/app/invoices/${invoiceId}?labelStatus=error&labelMessage=${encodeURIComponent("NCP numbers are only generated for paid invoices")}`));
      }

      const isVatExempt = Boolean(sale.customerVatNumber);
      const isValidEmail = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

      const draftOrderInput: any = {
        customerId: sale.customerId || undefined,
        email: sale.customerEmail && isValidEmail(sale.customerEmail) ? sale.customerEmail : undefined,
        phone: sale.customerPhone || undefined,
        taxExempt: isVatExempt,
        note: sale.reference || undefined,
        tags: ["Invoice App", sale.paymentMethod, sale.paymentStatus].filter(Boolean),
        customAttributes: [
          { key: "Payment Method", value: sale.paymentMethod || "-" },
          { key: "Payment Status", value: sale.paymentStatus || "Paid" },
          { key: "Amount Paid", value: `£${Number(sale.amountPaid || 0).toFixed(2)}` },
          { key: "VAT Number", value: sale.customerVatNumber || "-" },
        ],
        lineItems: (sale.lineItems || []).map((item: any) => {
          const netUnitPrice = Math.round(Number(item.unitPrice || 0) * 100) / 100;
          const grossUnitPrice = getGrossPrice(netUnitPrice, isVatExempt);
          const netDiscount = Math.round(Number(item.discount || 0) * 100) / 100;
          const grossDiscount = isVatExempt ? netDiscount : Math.round(netDiscount * (1 + VAT_RATE) * 100) / 100;
          return {
            quantity: Number(item.quantity || 1),
            title: item.title || "Custom item",
            sku: item.sku || undefined,
            originalUnitPriceWithCurrency: { amount: grossUnitPrice.toFixed(2), currencyCode: "GBP" },
            taxable: false,
            appliedDiscount: grossDiscount ? { value: grossDiscount, valueType: "FIXED_AMOUNT", title: "Manual discount" } : null,
          };
        }),
      };

      console.log(`generateNcpNumber: Creating draft order for invoice ${invoiceId} with email "${sale.customerEmail}"`);

      const createDraftResponse = await admin.graphql(
        `
          mutation CreateDraftOrder($input: DraftOrderInput!) {
            draftOrderCreate(input: $input) {
              draftOrder { id name }
              userErrors { field message }
            }
          }
        `,
        { variables: { input: draftOrderInput } },
      );

      const createDraftJson = (await createDraftResponse.json()) as any;
      const createErrors = createDraftJson.data?.draftOrderCreate?.userErrors || [];

      if (createErrors.length > 0) {
        console.error(`generateNcpNumber: Draft order creation failed: ${JSON.stringify(createErrors)}`);
        return redirect(withEmbeddedParamsFromRequest(request, `/app/invoices/${invoiceId}?labelStatus=error&labelMessage=${encodeURIComponent(createErrors.map((e: any) => e.message).join(", "))}`));
      }

      const draftOrderId = createDraftJson.data.draftOrderCreate.draftOrder.id;
      console.log(`generateNcpNumber: Draft order created: ${draftOrderId}, completing...`);

      const completeDraftResponse = await admin.graphql(
        `
          mutation CompleteDraftOrder($id: ID!, $paymentPending: Boolean!) {
            draftOrderComplete(id: $id, paymentPending: $paymentPending) {
              draftOrder { id order { id name } }
              userErrors { field message }
            }
          }
        `,
        { variables: { id: draftOrderId, paymentPending: false } },
      );

      const completeDraftJson = (await completeDraftResponse.json()) as any;
      const completeErrors = completeDraftJson.data?.draftOrderComplete?.userErrors || [];

      if (completeErrors.length > 0) {
        console.error(`generateNcpNumber: Draft order completion failed: ${JSON.stringify(completeErrors)}`);
        return redirect(withEmbeddedParamsFromRequest(request, `/app/invoices/${invoiceId}?labelStatus=error&labelMessage=${encodeURIComponent(completeErrors.map((e: any) => e.message).join(", "))}`));
      }

      const shopifyOrder = completeDraftJson.data.draftOrderComplete.draftOrder.order;
      console.log(`generateNcpNumber: NCP number generated: ${shopifyOrder?.name || ""}`);

      await prisma.sale.update({
        where: { id: invoiceId },
        data: {
          shopifyOrderId: shopifyOrder?.id || null,
          shopifyOrderName: shopifyOrder?.name || null,
        },
      });

      return redirect(withEmbeddedParamsFromRequest(request, `/app/invoices/${invoiceId}?labelStatus=success&labelMessage=${encodeURIComponent(`NCP number generated: ${shopifyOrder?.name || ""}`)}`) );
    } catch (error: any) {
      console.error("Generate NCP number failed:", error);
      return redirect(withEmbeddedParamsFromRequest(request, `/app/invoices/${invoiceId}?labelStatus=error&labelMessage=${encodeURIComponent(String(error?.message || "Failed to generate NCP number"))}`) );
    }
  }

  if (intent === "sendToXero") {
    let xeroClient: Awaited<ReturnType<typeof getConnectedXeroClient>>;
    try {
      xeroClient = await getConnectedXeroClient();
    } catch {
      return redirect(withEmbeddedParamsFromRequest(request, `/app/invoices/${invoiceId}?labelStatus=error&labelMessage=${encodeURIComponent("Xero is not connected. Connect Xero first.")}`));
    }
    const { xero, tenantId } = xeroClient;

    const sale = await prisma.sale.findUnique({
      where: { id: invoiceId },
      select: {
        id: true,
        customerName: true,
        customerEmail: true,
        shopifyOrderName: true,
        reference: true,
      },
    });

    if (!sale) {
      return redirect(withEmbeddedParamsFromRequest(request, `/app/invoices/${invoiceId}?labelStatus=error&labelMessage=${encodeURIComponent("Invoice not found")}`));
    }

    // Load vatType via raw SQL to avoid schema-version crashes
    let saleVatType = "Standard";
    try {
      const extraRows = await prisma.$queryRaw<Array<{ vatType: string | null }>>`
        SELECT "vatType"::text FROM "Sale" WHERE id = ${invoiceId} LIMIT 1
      `;
      if (extraRows.length > 0) saleVatType = extraRows[0].vatType ?? "Standard";
    } catch {}

    const isVatExempt = saleVatType === "Exempt" || saleVatType === "CrossBorder";
    const taxType = saleVatType === "CrossBorder" ? "ZERORATEDOUTPUT"
      : isVatExempt ? "EXEMPTOUTPUT"
      : "OUTPUT2";
    // Always use the configured sales account code.
    // Per Xero API docs, taxType on a line item explicitly overrides the account's default
    // tax type — so sending accountCode=205 with taxType="OUTPUT2" uses 20% VAT on Income.
    const accountCode = process.env.XERO_SALES_ACCOUNT_CODE || "205";

    // Base number for Xero invoice numbering
    const baseNumber = `INV-${sale.id}`;

    // Load Payment records via raw SQL — try with xeroInvoiceId, fall back without
    type PaymentRow = { id: number; amount: number; method: string; createdAt: Date; reference: string | null; xeroInvoiceId: string | null };
    let allPayments: PaymentRow[] = [];
    try {
      allPayments = await prisma.$queryRaw<PaymentRow[]>`
        SELECT id, amount, method::text as method, "createdAt", reference, "xeroInvoiceId"
        FROM "Payment" WHERE "saleId" = ${invoiceId} ORDER BY "createdAt" ASC
      `;
    } catch {
      try {
        const rows = await prisma.$queryRaw<Omit<PaymentRow, "xeroInvoiceId">[]>`
          SELECT id, amount, method::text as method, "createdAt", reference
          FROM "Payment" WHERE "saleId" = ${invoiceId} ORDER BY "createdAt" ASC
        `;
        allPayments = rows.map((r) => ({ ...r, xeroInvoiceId: null }));
      } catch {}
    }

    if (allPayments.length === 0) {
      return redirect(withEmbeddedParamsFromRequest(request, `/app/invoices/${invoiceId}?labelStatus=error&labelMessage=${encodeURIComponent("No payment records found. Record at least one payment against this invoice first.")}`));
    }

    const alreadySentCount = allPayments.filter((p) => p.xeroInvoiceId).length;
    const unsentPayments = allPayments.filter((p) => !p.xeroInvoiceId);

    if (unsentPayments.length === 0) {
      const rangeLabel = alreadySentCount === 1
        ? `${baseNumber}.1`
        : `${baseNumber}.1–${baseNumber}.${alreadySentCount}`;
      return redirect(withEmbeddedParamsFromRequest(request, `/app/invoices/${invoiceId}?labelStatus=success&labelMessage=${encodeURIComponent(`All ${alreadySentCount} payment invoice(s) already in Xero (${rangeLabel})`)}`));
    }

    let sentCount = 0;
    const xeroErrors: string[] = [];
    let lastXeroInvoiceId: string | null = null;

    for (let i = 0; i < unsentPayments.length; i++) {
      const payment = unsentPayments[i];
      const suffix = alreadySentCount + i + 1;
      const xeroInvoiceNumber = `${baseNumber}.${suffix}`;

      // Atomically claim this payment before calling Xero — prevents the race between
      // the auto-push (fire-and-forget) and this manual push both seeing
      // xeroInvoiceId IS NULL and creating duplicate invoices.
      let claimed = 0;
      try {
        claimed = Number(await prisma.$executeRaw`
          UPDATE "Payment" SET "xeroInvoiceId" = 'PENDING'
          WHERE id = ${payment.id} AND "xeroInvoiceId" IS NULL
        `);
      } catch {
        console.warn(`[Xero sendToXero] could not claim payment ${payment.id} — skipping`);
        continue;
      }
      if (claimed === 0) {
        console.log(`[Xero sendToXero] payment ${payment.id} already claimed by another process — skipping`);
        continue;
      }

      const dateStr = new Date(payment.createdAt).toISOString().split("T")[0];
      // EXCLUSIVE line amounts: supply net price; Xero adds VAT based on taxType.
      // This forces Xero to respect our taxType even if account 205 has a different default.
      // For OUTPUT2 (20%): net = payment / 1.2  — Xero total = net × 1.2 = original amount ✓
      // For zero-rated/exempt: net = full amount (no VAT to strip out)
      const vatMultiplier = taxType === "OUTPUT2" ? 1.2 : 1.0;
      const netAmount = Math.round((Number(payment.amount) / vatMultiplier) * 100) / 100;

      console.log(`[Xero sendToXero] invoice=${invoiceId} payment=${payment.id} saleVatType=${saleVatType} taxType=${taxType} accountCode=${accountCode} grossAmount=${payment.amount} netAmount=${netAmount} lineAmountTypes=Exclusive`);

      try {
        const response = await (xero.accountingApi as any).createInvoices(tenantId, {
          invoices: [{
            type: Invoice.TypeEnum.ACCREC,
            contact: {
              name: `Shopify - ${sale.customerName || "Customer"}`,
              ...(sale.customerEmail ? { emailAddress: sale.customerEmail } : {}),
            },
            date: dateStr,
            dueDate: dateStr,
            lineAmountTypes: LineAmountTypes.Exclusive,
            lineItems: [{
              description: `Payment ${suffix} — ${String(payment.method)}${payment.reference ? ` (${payment.reference})` : ""}`,
              quantity: 1,
              unitAmount: netAmount,
              taxType,
              accountCode,
            }],
            reference: baseNumber,
            invoiceNumber: xeroInvoiceNumber,
            sentToContact: true,
            status: Invoice.StatusEnum.AUTHORISED,
          }],
        });

        const validationErrors = response.body?.invoices?.[0]?.validationErrors || [];
        const newXeroInvoiceId: string | undefined = response.body?.invoices?.[0]?.invoiceID;
        const returnedLineItem = response.body?.invoices?.[0]?.lineItems?.[0];

        console.log(`[Xero sendToXero] response for ${xeroInvoiceNumber}: invoiceID=${newXeroInvoiceId} returnedTaxType=${returnedLineItem?.taxType} returnedTaxAmount=${returnedLineItem?.taxAmount} returnedAccountCode=${returnedLineItem?.accountCode} lineAmountTypes=${response.body?.invoices?.[0]?.lineAmountTypes}`);

        if (validationErrors.length > 0) {
          xeroErrors.push(`${xeroInvoiceNumber}: ${validationErrors.map((e: any) => e.message).join("; ")}`);
          continue;
        }

        if (newXeroInvoiceId) {
          // Mark this payment as sent — save the Xero invoice ID
          try {
            await prisma.$executeRaw`UPDATE "Payment" SET "xeroInvoiceId" = ${newXeroInvoiceId} WHERE id = ${payment.id}`;
          } catch {
            console.warn(`xeroInvoiceId column not yet available for payment ${payment.id}`);
          }
          sentCount++;
          lastXeroInvoiceId = newXeroInvoiceId;
        }
      } catch (err: any) {
        // Clear the PENDING claim so the payment can be retried
        try {
          await prisma.$executeRaw`UPDATE "Payment" SET "xeroInvoiceId" = NULL WHERE id = ${payment.id} AND "xeroInvoiceId" = 'PENDING'`;
        } catch {}
        console.error(`Failed to create Xero invoice ${xeroInvoiceNumber}:`, err);
        xeroErrors.push(`${xeroInvoiceNumber}: ${err?.response?.body?.Detail || err?.message || "Unknown error"}`);
      }
    }

    // Keep Sale.xeroInvoiceId pointing at the most recently created invoice
    if (lastXeroInvoiceId) {
      try {
        await prisma.$executeRaw`UPDATE "Sale" SET "xeroInvoiceId" = ${lastXeroInvoiceId} WHERE id = ${invoiceId}`;
      } catch {}
    }

    if (sentCount === 0) {
      return redirect(withEmbeddedParamsFromRequest(request, `/app/invoices/${invoiceId}?labelStatus=error&labelMessage=${encodeURIComponent(xeroErrors.join(" | ") || "Failed to create Xero invoices")}`));
    }

    const firstSuffix = alreadySentCount + 1;
    const lastSuffix = alreadySentCount + sentCount;
    const rangeLabel = sentCount === 1
      ? `${baseNumber}.${firstSuffix}`
      : `${baseNumber}.${firstSuffix}–${baseNumber}.${lastSuffix}`;
    const partialNote = sentCount < unsentPayments.length ? ` (${unsentPayments.length - sentCount} failed)` : "";
    return redirect(withEmbeddedParamsFromRequest(request, `/app/invoices/${invoiceId}?labelStatus=success&labelMessage=${encodeURIComponent(`Sent ${sentCount} invoice(s) to Xero: ${rangeLabel}${partialNote}`)}`));
  }

  if (intent === "sendEmail") {
    try {
      const sale = await prisma.sale.findUnique({
        where: { id: invoiceId },
        select: { customerEmail: true, customerName: true, paymentStatus: true },
      });
      if (!sale?.customerEmail) {
        return redirect(withEmbeddedParamsFromRequest(request, `/app/invoices/${invoiceId}?labelStatus=error&labelMessage=${encodeURIComponent("No customer email address on file for this invoice")}`));
      }
      const { generateInvoicePdf } = await import("../utils/invoice-pdf.server");
      const { sendInvoiceEmail } = await import("../utils/email.server");
      const pdfBuffer = await generateInvoicePdf(invoiceId);
      await sendInvoiceEmail({
        to: sale.customerEmail,
        customerName: sale.customerName || "",
        invoiceId,
        pdfBuffer,
        paymentStatus: sale.paymentStatus || "Unpaid",
      });
      return redirect(withEmbeddedParamsFromRequest(request, `/app/invoices/${invoiceId}?labelStatus=success&labelMessage=${encodeURIComponent(`Invoice emailed to ${sale.customerEmail}`)}`));
    } catch (error: any) {
      console.error("Send email failed:", error);
      return redirect(withEmbeddedParamsFromRequest(request, `/app/invoices/${invoiceId}?labelStatus=error&labelMessage=${encodeURIComponent(`Email failed: ${error?.message || "Unknown error"}`)}`));
    }
  }

  if (intent !== "generateShippingLabel") {
    return null;
  }

  try {
    const sale = await prisma.sale.findUnique({
      where: { id: invoiceId },
      select: {
        id: true,
        shopifyOrderId: true,
        shopifyOrderName: true,
        customerName: true,
        customerEmail: true,
        customerPhone: true,
        address1: true,
        address2: true,
        city: true,
        county: true,
        postcode: true,
        country: true,
      },
    });

    if (!sale) {
      return redirect(
        withEmbeddedParamsFromRequest(
          request,
          `/app/invoices/${invoiceId}?labelStatus=error&labelMessage=${encodeURIComponent("Invoice not found")}`,
        ),
      );
    }

    const shippingMeta = await getSaleShippingMeta(invoiceId);
    if (shippingMeta.shippingMethod !== "Delivery") {
      return redirect(
        withEmbeddedParamsFromRequest(
          request,
          `/app/invoices/${invoiceId}?labelStatus=error&labelMessage=${encodeURIComponent("Shipping labels are only available for delivery orders")}`,
        ),
      );
    }

    const label = await generateShippingLabel({
      invoiceId,
      shopifyOrderId: sale.shopifyOrderId,
      shopifyOrderName: sale.shopifyOrderName,
      customerName: sale.customerName,
      customerEmail: sale.customerEmail,
      customerPhone: sale.customerPhone,
      address1: sale.address1,
      address2: sale.address2,
      city: sale.city,
      county: sale.county,
      postcode: sale.postcode,
      country: sale.country,
      deliveryMethod: shippingMeta.deliveryMethod,
    });

    if (!label) {
      return redirect(
        withEmbeddedParamsFromRequest(
          request,
          `/app/invoices/${invoiceId}?labelStatus=error&labelMessage=${encodeURIComponent("Shipping label integration is not configured")}`,
        ),
      );
    }

      await upsertSaleShippingMeta({
        trackingUrl: shippingMeta.trackingUrl,
        carrierName: shippingMeta.carrierName,
      saleId: invoiceId,
      shippingMethod: shippingMeta.shippingMethod,
      trackingNumber: shippingMeta.trackingNumber,
      fulfillmentStatus: shippingMeta.fulfillmentStatus,
      deliveryMethod: shippingMeta.deliveryMethod,
      deliveryStatus: "Label generated",
    });

    return redirect(
      withEmbeddedParamsFromRequest(
        request,
        `/app/invoices/${invoiceId}?labelStatus=success&labelMessage=${encodeURIComponent("Shipping label generated")}&labelUrl=${encodeURIComponent(label.labelUrl)}`,
      ),
    );
  } catch (error: any) {
    console.error("Generate shipping label failed:", error);
    return redirect(
      withEmbeddedParamsFromRequest(
        request,
        `/app/invoices/${invoiceId}?labelStatus=error&labelMessage=${encodeURIComponent(String(error?.message || "Shipping label generation failed"))}`,
      ),
    );
  }
}

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { invoiceId: string };
}) {
  try {
    await authenticate.admin(request);

    const invoiceId = Number(params.invoiceId);

    const sale = await prisma.sale.findUnique({
      where: { id: invoiceId },
      select: {
        id: true,
        shopifyOrderId: true,
        shopifyOrderName: true,
        customerId: true,
        customerName: true,
        customerEmail: true,
        customerVatNumber: true,
        customerPhone: true,
        address1: true,
        address2: true,
        city: true,
        county: true,
        postcode: true,
        country: true,
        deliveryAddress1: true,
        deliveryAddress2: true,
        deliveryCity: true,
        deliveryCounty: true,
        deliveryPostcode: true,
        deliveryCountry: true,
        reference: true,
        paymentMethod: true,
        subtotal: true,
        discountTotal: true,
        vatAmount: true,
        total: true,
        amountPaid: true,
        balanceDue: true,
        paymentStatus: true,
        depositPaid: true,
        staffId: true,
        createdAt: true,
      },
    });

    if (!sale) {
      throw new Response("Invoice not found", { status: 404 });
    }

    // Load optional columns that may not exist in older DB migrations
    let vatType: string | null = "Standard";
    let xeroInvoiceId: string | null = null;
    try {
      const extraRows = await prisma.$queryRaw<Array<{ vatType: string | null; xeroInvoiceId: string | null }>>`
        SELECT "vatType"::text, "xeroInvoiceId"
        FROM "Sale"
        WHERE id = ${invoiceId}
        LIMIT 1
      `;
      if (extraRows.length > 0) {
        vatType = extraRows[0].vatType ?? "Standard";
        xeroInvoiceId = extraRows[0].xeroInvoiceId ?? null;
      }
    } catch {
      // Columns don't exist yet — use safe defaults
    }

    const [staff, lineItems, shippingMeta] = await Promise.all([
      prisma.staff.findUnique({
        where: { id: sale.staffId },
        select: { name: true },
      }),
      prisma.saleLineItem.findMany({
        where: { saleId: invoiceId },
        orderBy: { id: "asc" },
        select: {
          id: true,
          title: true,
          sku: true,
          imageUrl: true,
          quantity: true,
          unitPrice: true,
          discount: true,
          lineTotal: true,
        },
      }),
      getSaleShippingMeta(invoiceId),
    ]);
    const discountMeta = await getInvoiceDiscountMeta(invoiceId);

    let recordedPaymentCount = 0;
    let recordedPaymentTotal = 0;
    let hasUnpushedPayments = false;

    try {
      const paymentAggregate = await prisma.payment.aggregate({
        where: { saleId: invoiceId },
        _count: { id: true },
        _sum: { amount: true },
      });

      recordedPaymentCount = Number(paymentAggregate?._count?.id || 0);
      recordedPaymentTotal = Number(paymentAggregate?._sum?.amount || 0);
    } catch (error) {
      // Keep invoice detail working on legacy databases where Payment may be unavailable.
      console.error("Failed to load payment aggregate for invoice:", error);
    }

    // Check for payments that haven't been pushed to Xero yet (NULL or stuck PENDING > 10 min)
    try {
      const unpushedRows = await prisma.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(*) as count FROM "Payment"
        WHERE "saleId" = ${invoiceId}
          AND ("xeroInvoiceId" IS NULL
            OR ("xeroInvoiceId" = 'PENDING' AND "createdAt" < NOW() - INTERVAL '10 minutes'))
      `;
      hasUnpushedPayments = Number(unpushedRows[0]?.count || 0) > 0;
    } catch {
      // Column may not exist yet — ignore
    }

    const fallbackAmountPaid = Number(sale.amountPaid || 0);

    const paymentSummary = {
      count: recordedPaymentCount || (fallbackAmountPaid > 0 ? 1 : 0),
      total: recordedPaymentTotal || fallbackAmountPaid,
      isEstimated: recordedPaymentCount === 0 && fallbackAmountPaid > 0,
    };

    const invoice = {
      ...sale,
      vatType,
      xeroInvoiceId,
      staff,
      shippingMethod: shippingMeta.shippingMethod,
      trackingNumber: shippingMeta.trackingNumber,
      trackingUrl: shippingMeta.trackingUrl,
      carrierName: shippingMeta.carrierName,
      fulfillmentStatus: shippingMeta.fulfillmentStatus,
      deliveryStatus: shippingMeta.deliveryStatus,
      deliveryMethod: shippingMeta.deliveryMethod,
      invoiceDiscountType: discountMeta.discountType || "amount",
      invoiceDiscountValue: discountMeta.discountValue ?? 0,
      invoiceDiscountAmount: discountMeta.discountAmount ?? 0,
      paymentSummary,
      hasUnpushedPayments,
      lineItems,
    };

    return {
      invoice,
      logoUrl: process.env.BUSINESS_LOGO_URL || "",
      xeroConfigured: Boolean(process.env.XERO_CLIENT_ID && process.env.XERO_CLIENT_SECRET),
      error: null,
    };
  } catch (error) {
    if (error instanceof Response) throw error;
    console.error("Failed to load invoice:", error);
    return {
      invoice: null,
      logoUrl: "",
      xeroConfigured: false,
      error: "Invoice could not be loaded right now.",
    };
  }
}

export default function PrintInvoicePage() {
  const { invoice, logoUrl, xeroConfigured, error } = useLoaderData<typeof loader>();
  const [searchParams] = useSearchParams();
  const labelStatus = searchParams.get("labelStatus");
  const labelMessage = searchParams.get("labelMessage");
  const labelUrl = searchParams.get("labelUrl");

  function withEmbeddedParams(path: string) {
    const [pathname, queryString = ""] = path.split("?");
    const nextParams = new URLSearchParams(queryString);
    const storageKey = "shopifyEmbeddedParams";

    let cachedParams: Record<string, string> = {};
    if (typeof window !== "undefined") {
      try {
        cachedParams = JSON.parse(window.sessionStorage.getItem(storageKey) || "{}") || {};
      } catch {
        cachedParams = {};
      }
    }

    let hasLiveParams = false;

    for (const key of ["shop", "host", "embedded", "id_token"]) {
      const value = searchParams.get(key);
      if (value) {
        hasLiveParams = true;
        cachedParams[key] = value;
      }

      const resolvedValue = value || cachedParams[key] || "";
      if (resolvedValue && !nextParams.has(key)) {
        nextParams.set(key, resolvedValue);
      }
    }

    if (hasLiveParams && typeof window !== "undefined") {
      try {
        window.sessionStorage.setItem(storageKey, JSON.stringify(cachedParams));
      } catch {
        // Ignore storage write failures and continue with available params.
      }
    }

    const nextQuery = nextParams.toString();
    return nextQuery ? `${pathname}?${nextQuery}` : pathname;
  }

  if (error || !invoice) {
    return <Banner tone="critical">{error || "Invoice not found."}</Banner>;
  }

  const loadedInvoice = invoice;

  const fulfilmentMethod = searchParams.get("fulfilmentMethod") || "Collected";
  const printMode = searchParams.get("printMode") || "";
  const autoprintEnabled = searchParams.get("autoprint") === "1";
  const normalizedPrintMode =
    printMode === "both" || printMode === "packing" || printMode === "invoice"
      ? printMode
      : "";
  const effectivePrintMode = normalizedPrintMode || "invoice";

  const packingOnlyPrint = effectivePrintMode === "packing";
  const showInvoiceSheet = !packingOnlyPrint;

  const shouldPrintPackingSlip =
    packingOnlyPrint ||
    effectivePrintMode === "both" ||
    (autoprintEnabled && !normalizedPrintMode &&
      (fulfilmentMethod === "Collecting" || fulfilmentMethod === "Delivery"));

  useEffect(() => {
    if (searchParams.get("autoprint") !== "1") return;

    const timer = window.setTimeout(() => {
      window.print();
    }, 500);

    return () => window.clearTimeout(timer);
  }, [searchParams]);

  function printWithMode(mode: "invoice" | "both") {
    const params = new URLSearchParams(searchParams.toString());
    params.set("autoprint", "1");
    params.set("printMode", mode);
    params.set("fulfilmentMethod", fulfilmentMethod);

    window.location.href = withEmbeddedParams(`${window.location.pathname}?${params.toString()}`);
  }

  const amountPaid = Number(loadedInvoice.amountPaid || 0);
  const partialPaymentCount = Number(loadedInvoice.paymentSummary?.count || 0);
  const partialPaymentTotal = Number(loadedInvoice.paymentSummary?.total || amountPaid || 0);
  const partialPaymentEstimated = Boolean(loadedInvoice.paymentSummary?.isEstimated);

  const balanceDue =
    loadedInvoice.balanceDue !== null && loadedInvoice.balanceDue !== undefined
      ? Number(loadedInvoice.balanceDue)
      : Math.max(Number(loadedInvoice.total || 0) - amountPaid, 0);

  const paymentStatus =
    loadedInvoice.paymentStatus ||
    (amountPaid <= 0
      ? "Unpaid"
      : amountPaid < Number(loadedInvoice.total || 0)
        ? "Partially Paid"
        : "Paid");

  async function downloadPdf(event?: React.MouseEvent<HTMLButtonElement>) {
    event?.preventDefault();
    event?.stopPropagation();

    const pdfUrl = withEmbeddedParams(window.location.pathname.replace(/\/$/, "") + "/pdf");

    try {
      const response = await fetch(pdfUrl);
      if (!response.ok) {
        let detail = "";
        try { const j = await response.json(); detail = j.error || ""; } catch {}
        throw new Error(`Server error ${response.status}${detail ? ": " + detail : ""}`);
      }
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = `Invoice-INV-${loadedInvoice.id}.pdf`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(objectUrl);
    } catch (err: any) {
      console.error("PDF download failed:", err);
      alert(`Failed to download PDF: ${err?.message || err}`);
    }
  }

  return (
    <div className={`page ${effectivePrintMode === "invoice" ? "single-sheet-print" : ""}`}>
      {labelStatus && labelMessage ? (
        <div style={{ marginBottom: 12 }}>
          <Banner tone={labelStatus === "success" ? "success" : "critical"}>
            {labelMessage}
            {labelStatus === "success" && labelUrl ? (
              <div style={{ marginTop: 8 }}>
                <a href={labelUrl} target="_blank" rel="noreferrer">
                  Open Shipping Label
                </a>
              </div>
            ) : null}
          </Banner>
        </div>
      ) : null}

      <style>{`
        body {
          margin: 0;
          background: #f4f4f4;
          font-family: Arial, sans-serif;
          color: #111;
        }

        .page {
          max-width: 900px;
          margin: 30px auto;
          background: white;
          padding: 45px;
          box-shadow: 0 0 10px rgba(0,0,0,0.12);
        }

        .invoice-print-sheet {
          display: block;
        }

        .actions {
          margin-bottom: 30px;
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
        }

        button {
          padding: 9px 15px;
          margin-right: 8px;
          cursor: pointer;
          border: 1px solid #111827;
          background: #111827;
          color: white;
          border-radius: 6px;
          font-weight: 600;
        }

        button.secondary {
          background: white;
          color: #111827;
        }

        .header {
          display: flex;
          justify-content: space-between;
          gap: 30px;
          background: white;
          color: #111;
          border-bottom: 3px solid #111827;
          padding-bottom: 25px;
          margin-bottom: 25px;
        }

        .invoice-title {
          font-size: 36px;
          letter-spacing: 1px;
          margin: 0;
          color: #111827;
          font-weight: 700;
          text-transform: uppercase;
        }

        .invoice-number {
          margin-top: 2px;
          font-size: 13px;
          color: #111827;
        }

        .business {
          text-align: right;
          min-width: 260px;
          font-size: 12px;
          line-height: 1.5;
        }

        .business h2 {
          font-size: 14px;
          margin: 8px 0 6px;
        }

        .logo {
          max-width: 190px;
          max-height: 90px;
          object-fit: contain;
          margin-bottom: 8px;
        }

        .meta-grid {
          display: grid;
          grid-template-columns: repeat(5, 1fr);
          border: 1px solid #dfe3e8;
          border-radius: 12px;
          overflow: hidden;
          margin-bottom: 28px;
        }

        .meta-cell {
          padding: 18px;
          border-right: 1px solid #dfe3e8;
          min-height: 58px;
        }

        .meta-cell:last-child {
          border-right: none;
        }

        .label {
          text-transform: uppercase;
          letter-spacing: 1px;
          color: #4b5870;
          font-size: 13px;
          margin-bottom: 12px;
        }

        .value {
          font-weight: 700;
          font-size: 14px;
        }

        .status-paid {
          color: #007a3d;
        }

        .status-partial {
          color: #a35f00;
        }

        .status-unpaid {
          color: #b00020;
        }

        .address-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 24px;
          margin-bottom: 28px;
        }

        .address-box {
          border: 1px solid #dfe3e8;
          border-radius: 12px;
          padding: 22px;
          min-height: 105px;
        }

        .address-title {
          text-transform: uppercase;
          letter-spacing: 1.5px;
          color: #111827;
          font-size: 15px;
          margin-bottom: 18px;
        }

        p {
          margin: 5px 0;
          font-size: 14px;
        }

        table {
          width: 100%;
          border-collapse: collapse;
          margin-top: 20px;
        }

        th {
          background: #111827;
          color: white;
          text-align: left;
          padding: 12px;
          font-size: 13px;
        }

        td {
          padding: 13px 12px;
          border-bottom: 1px solid #dfe3e8;
          vertical-align: top;
          font-size: 13px;
        }

        .right {
          text-align: right;
        }

        .totals {
          width: 390px;
          margin-left: auto;
          margin-top: 28px;
          border: 1px solid #dfe3e8;
          border-radius: 12px;
          overflow: hidden;
        }

        .totals-row {
          display: flex;
          justify-content: space-between;
          padding: 14px 18px;
          border-bottom: 1px solid #dfe3e8;
          font-size: 14px;
        }

        .totals-row:last-child {
          border-bottom: none;
        }

        .total-row {
          background: #111827;
          color: white;
          font-weight: 700;
          font-size: 20px;
        }

        .paid-row {
          background: white;
        }

        .balance-row {
          background: #fff1f1;
          color: #9b0000;
          font-weight: 700;
          font-size: 16px;
        }

        .payments-row {
          background: #eff7ff;
        }

        .payments-note {
          display: block;
          margin-top: 6px;
          font-size: 11px;
          color: #4b5870;
        }

        .footer {
          margin-top: 50px;
          font-size: 13px;
          color: #555;
          border-top: 1px solid #ddd;
          padding-top: 15px;
        }

        .packing-slip {
          display: none;
        }

        .packing-slip-visible {
          display: block;
          page-break-before: auto;
        }

        .packing-header {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          margin-bottom: 28px;
        }

        .packing-title {
          font-size: 22px;
          font-weight: 700;
        }

        .packing-subtitle {
          font-size: 12px;
          margin-top: 4px;
          color: #555;
        }

        .packing-order {
          text-align: right;
          font-size: 11px;
          font-weight: 700;
        }

        .packing-from {
          font-size: 11px;
          line-height: 1.25;
          margin-bottom: 22px;
        }

        .packing-line {
          border-top: 1px solid #111;
          margin: 18px 0;
        }

        .packing-section-title {
          font-size: 12px;
          font-weight: 700;
          margin-bottom: 10px;
        }

        .packing-table {
          width: 100%;
          border-collapse: collapse;
          font-size: 11px;
        }

        .packing-table th {
          background: white;
          color: #111;
          border: 1px solid #ccc;
          padding: 8px;
          font-size: 11px;
        }

        .packing-table td {
          border: 1px solid #ddd;
          padding: 8px;
          vertical-align: middle;
          font-size: 11px;
        }

        .packing-img {
          width: 58px;
          height: 58px;
          object-fit: contain;
        }

        .packing-item {
          font-weight: 700;
        }

        .packing-sku {
          font-size: 10px;
          color: #555;
        }

        @media print {
          @page {
            size: A4 portrait;
            margin: 6mm;
          }

          body {
            background: white;
          }

          .page {
            margin: 0;
            max-width: none;
            box-shadow: none;
            padding: 8px;
          }

          .invoice-print-sheet {
            font-size: 11px;
          }

          .invoice-print-sheet .header {
            margin-bottom: 10px;
            padding-bottom: 8px;
          }

          .invoice-print-sheet .invoice-title {
            font-size: 24px;
          }

          .invoice-print-sheet .business {
            font-size: 10px;
            line-height: 1.2;
          }

          .invoice-print-sheet .meta-grid {
            margin-bottom: 10px;
          }

          .invoice-print-sheet .meta-cell {
            padding: 8px;
            min-height: auto;
          }

          .invoice-print-sheet .label {
            margin-bottom: 4px;
            font-size: 10px;
          }

          .invoice-print-sheet .value {
            font-size: 11px;
          }

          .invoice-print-sheet .address-grid {
            gap: 8px;
            margin-bottom: 10px;
          }

          .invoice-print-sheet .address-box {
            padding: 8px;
            min-height: auto;
          }

          .invoice-print-sheet .address-title {
            margin-bottom: 6px;
            font-size: 11px;
          }

          .invoice-print-sheet p {
            margin: 1px 0;
            font-size: 11px;
            line-height: 1.15;
          }

          .invoice-print-sheet table {
            margin-top: 6px;
          }

          .invoice-print-sheet th,
          .invoice-print-sheet td {
            padding: 5px 6px;
            font-size: 10px;
            line-height: 1.15;
          }

          .invoice-print-sheet .totals {
            width: 320px;
            margin-top: 6px;
          }

          .invoice-print-sheet .totals-row {
            padding: 6px 8px;
            font-size: 10px;
          }

          .invoice-print-sheet .total-row {
            font-size: 12px;
          }

          .invoice-print-sheet .balance-row {
            font-size: 11px;
          }

          .single-sheet-print.page {
            padding: 10px;
          }

          .single-sheet-print .header {
            margin-bottom: 14px;
            padding-bottom: 12px;
          }

          .single-sheet-print .invoice-title {
            font-size: 28px;
          }

          .single-sheet-print .business {
            font-size: 11px;
            line-height: 1.25;
          }

          .single-sheet-print .meta-grid {
            margin-bottom: 14px;
          }

          .single-sheet-print .meta-cell {
            padding: 10px;
            min-height: auto;
          }

          .single-sheet-print .label {
            margin-bottom: 6px;
            font-size: 11px;
          }

          .single-sheet-print .value {
            font-size: 12px;
          }

          .single-sheet-print .address-grid {
            gap: 12px;
            margin-bottom: 14px;
          }

          .single-sheet-print .address-box {
            padding: 12px;
            min-height: auto;
          }

          .single-sheet-print .address-title {
            font-size: 12px;
            margin-bottom: 8px;
          }

          .single-sheet-print p {
            margin: 2px 0;
            font-size: 12px;
            line-height: 1.2;
          }

          .single-sheet-print table {
            margin-top: 10px;
          }

          .single-sheet-print th,
          .single-sheet-print td {
            padding: 6px 7px;
            font-size: 11px;
            line-height: 1.2;
          }

          .single-sheet-print .totals {
            width: 330px;
            margin-top: 12px;
          }

          .single-sheet-print .totals-row {
            padding: 8px 10px;
            font-size: 12px;
          }

          .single-sheet-print .total-row {
            font-size: 15px;
          }

          .single-sheet-print .balance-row {
            font-size: 13px;
          }

          .single-sheet-print .footer {
            display: block;
            margin-top: 14px;
            padding-top: 8px;
            font-size: 11px;
          }

          .invoice-print-sheet,
          .single-sheet-print .invoice-print-sheet {
            page-break-inside: auto;
            break-inside: auto;
          }

          .totals {
            margin-top: 10px;
          }

          .footer {
            margin-top: 8px;
            padding-top: 6px;
            font-size: 11px;
            page-break-before: avoid;
            break-before: avoid;
            page-break-inside: avoid;
            break-inside: avoid;
            display: none;
          }

          .payments-note {
            display: none;
          }

          .actions,
          button {
            display: none;
          }

          .packing-slip {
            display: block;
            page-break-before: always;
            break-before: page;
            padding-top: 10px;
          }
        }
      `}</style>

      <div className="actions">
        <button
          type="button"
          className="secondary"
          onClick={() => {
            window.location.href = withEmbeddedParams(`/app/invoice?editInvoiceId=${invoice.id}`);
          }}
        >
          Edit Invoice
        </button>

        <button
          type="button"
          onClick={() => printWithMode("invoice")}
        >
          Print One Sheet
        </button>

        <button
          type="button"
          className="secondary"
          onClick={() => printWithMode("both")}
        >
          Print Two Sheets
        </button>

        {invoice.shippingMethod === "Delivery" ? (
          <Form method="post">
            <input type="hidden" name="_intent" value="generateShippingLabel" />
            <button type="submit" className="secondary">Generate Shipping Label</button>
          </Form>
        ) : null}

        {!invoice.shopifyOrderId && String(invoice.paymentStatus || "").toLowerCase() === "paid" ? (
          <Form method="post">
            <input type="hidden" name="_intent" value="generateNcpNumber" />
            <button type="submit" className="secondary">Generate NCP Number</button>
          </Form>
        ) : null}

        {xeroConfigured && String(invoice.paymentStatus || "").toLowerCase() === "paid" && (invoice.hasUnpushedPayments || !invoice.xeroInvoiceId) ? (
          <Form method="post">
            <input type="hidden" name="_intent" value="sendToXero" />
            <button type="submit" className="secondary">Send to Xero</button>
          </Form>
        ) : null}

        {xeroConfigured && invoice.xeroInvoiceId && !invoice.hasUnpushedPayments ? (
          <span className="secondary" style={{ padding: "6px 12px", border: "1px solid #ccc", borderRadius: 4, fontSize: 14, color: "#555" }}>
            ✓ In Xero
          </span>
        ) : null}

        <button type="button" onClick={downloadPdf}>
          Download PDF
        </button>

        {invoice.customerEmail ? (
          <Form method="post">
            <input type="hidden" name="_intent" value="sendEmail" />
            <button type="submit" className="secondary">Send Email</button>
          </Form>
        ) : null}

        <Form method="post">
          <input type="hidden" name="_intent" value="deleteInvoice" />
          <button
            type="submit"
            className="secondary"
            style={{ borderColor: "#b00020", color: "#b00020" }}
            onClick={(event) => {
              if (!window.confirm(`Delete invoice INV-${invoice.id}? This cannot be undone.`)) {
                event.preventDefault();
              }
            }}
          >
            Delete Invoice
          </button>
        </Form>

        <button
          type="button"
          className="secondary"
          onClick={() => window.history.back()}
        >
          Back
        </button>
      </div>

      {showInvoiceSheet ? (
      <div className="invoice-print-sheet">

        {/* ── Logo banner ── */}
        {logoUrl ? (
          <div style={{ textAlign: "center", marginBottom: 18 }}>
            <img src={logoUrl} alt="NII Clean Products" className="logo" style={{ maxWidth: 280, maxHeight: 100 }} />
          </div>
        ) : null}

      <div className="header">
        {/* LEFT: TAX INVOICE + customer */}
        <div>
          <h1 className="invoice-title">TAX INVOICE</h1>
          <div style={{ marginTop: 8, fontSize: 16, fontWeight: 600 }}>{invoice.customerName}</div>
          {invoice.customerEmail ? <div style={{ fontSize: 12, color: "#555", marginTop: 2 }}>{invoice.customerEmail}</div> : null}
          {invoice.customerPhone ? <div style={{ fontSize: 12, color: "#555", marginTop: 2 }}>{invoice.customerPhone}</div> : null}
          {invoice.customerVatNumber ? <div style={{ fontSize: 12, color: "#555", marginTop: 2 }}>VAT: {invoice.customerVatNumber}</div> : null}
        </div>

        {/* RIGHT: business info + invoice date/number */}
        <div className="business">
          <h2>NII Clean Products</h2>
          <p>96 Bushmills Road</p>
          <p>Coleraine BT52 2BT</p>
          <p>United Kingdom</p>
          <p>+447711781911</p>
          <p style={{ marginTop: 10, borderTop: "1px solid #ddd", paddingTop: 8 }}>
            <span style={{ textTransform: "uppercase", fontSize: 10, color: "#888", letterSpacing: 1 }}>Invoice Date</span><br />
            <strong>{formatDate(invoice.createdAt)}</strong>
          </p>
          <p style={{ marginTop: 6 }}>
            <span style={{ textTransform: "uppercase", fontSize: 10, color: "#888", letterSpacing: 1 }}>Invoice Number</span><br />
            <strong>{invoice.shopifyOrderName || `INV-${invoice.id}`}</strong>
          </p>
        </div>
      </div>

      {/* ── Customer address (only if set) ── */}
      {(invoice.address1 || invoice.city || invoice.postcode) ? (
        <div style={{ marginBottom: 18, fontSize: 13, color: "#333" }}>
          <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 1, color: "#888", marginBottom: 4 }}>Bill To</div>
          {invoice.address1 ? <div>{invoice.address1}</div> : null}
          {invoice.address2 ? <div>{invoice.address2}</div> : null}
          {[invoice.city, invoice.county].filter(Boolean).join(", ") ? <div>{[invoice.city, invoice.county].filter(Boolean).join(", ")}</div> : null}
          {invoice.postcode ? <div>{invoice.postcode}</div> : null}
          {invoice.country ? <div>{invoice.country}</div> : null}
        </div>
      ) : null}

      <table>
        <thead>
          <tr>
            <th>Item</th>
            <th>Description / SKU</th>
            <th className="right">Quantity</th>
            <th className="right">Unit Price</th>
            <th className="right">VAT</th>
            <th className="right">Amount GBP</th>
          </tr>
        </thead>

        <tbody>
          {invoice.lineItems.map((item: any) => (
            <tr key={item.id}>
              <td>{item.sku || "-"}</td>
              <td>{item.title}</td>
              <td className="right">{item.quantity}</td>
              <td className="right">{money(item.unitPrice)}</td>
              <td className="right">{invoice.vatType === "Exempt" || invoice.vatType === "CrossBorder" ? "0%" : "20%"}</td>
              <td className="right">{money(item.lineTotal)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="totals">
        <div className="totals-row">
          <span>Subtotal</span>
          <span>{money(invoice.subtotal)}</span>
        </div>

        <div className="totals-row">
          <span>TOTAL VAT {invoice.vatType === "Exempt" || invoice.vatType === "CrossBorder" ? "0%" : "20%"}</span>
          <span>{money(invoice.vatAmount)}</span>
        </div>

        {(Number(invoice.discountTotal) > 0 || Number(invoice.invoiceDiscountAmount) > 0) ? (
          <div className="totals-row">
            <span>Discount</span>
            <span>-{money(Number(invoice.discountTotal || 0) + Number(invoice.invoiceDiscountAmount || 0))}</span>
          </div>
        ) : null}

        <div className="totals-row total-row">
          <span>TOTAL GBP</span>
          <span>{money(invoice.total)}</span>
        </div>

        <div className="totals-row paid-row">
          <span>Less Amount Paid</span>
          <span>{money(amountPaid)}</span>
        </div>

        <div className={`totals-row ${balanceDue > 0 ? "balance-row" : ""}`}>
          <span>AMOUNT DUE GBP</span>
          <span>{money(balanceDue)}</span>
        </div>
      </div>

      <div className="footer">
        {balanceDue > 0 ? (
          <>
            <p style={{ margin: "0 0 4px" }}><strong>Due Date:</strong> {formatDate(invoice.createdAt)}</p>
            <p style={{ margin: "0 0 3px" }}>INVOICES CAN BE PAID VIA BANK TRANSFER OR BY CALLING 02870348834 TO PAY OVER THE PHONE.</p>
            <p style={{ margin: "0 0 6px" }}>Registered in Northern Ireland &nbsp;|&nbsp; VAT Registration Number XI369865135</p>
            <p style={{ margin: "0 0 2px" }}><strong>Danske Bank</strong></p>
            <p style={{ margin: "0 0 2px" }}>Name On Account : NII Clean Ltd</p>
            <p style={{ margin: "0 0 2px" }}>Sort Code : 95 06 79 &nbsp;&nbsp; Account Number : 40254274</p>
            <p style={{ margin: "0 0 2px" }}>IBAN : GB83 DABA 9506 7940 2542 74 &nbsp;&nbsp; BIC/SWIFT : DABAGB2B</p>
          </>
        ) : (
          <p style={{ margin: 0 }}>Registered in Northern Ireland &nbsp;|&nbsp; VAT Registration Number XI369865135</p>
        )}
        <div style={{ marginTop: 20, padding: "14px 18px", background: "#eff6ff", borderRadius: 8, textAlign: "center", borderLeft: "4px solid #2563eb" }}>
          <p style={{ margin: 0, fontWeight: 700, fontSize: 14, color: "#1d4ed8" }}>Thank you for shopping with NII Clean Products!</p>
          <p style={{ margin: "4px 0 0", color: "#3b82f6", fontSize: 12 }}>We appreciate your business so much. We look forward to seeing you again.</p>
        </div>
      </div>
      </div>
      ) : null}

      {shouldPrintPackingSlip && (
        <div className={`packing-slip ${packingOnlyPrint ? "packing-slip-visible" : ""}`}>
          <div className="packing-header">
            <div>
              <div className="packing-title">Packing Slip</div>
              <div className="packing-subtitle">Internal use only</div>
            </div>

            <div className="packing-order">
              <div>Order INV-{invoice.id}</div>
              <div>{formatDate(invoice.createdAt)}</div>
            </div>
          </div>

          <div className="packing-from">
            <strong>From</strong>
            <br />
            NII Clean Products
            <br />
            96 Bushmills Road
            <br />
            Coleraine BT52 2BT
            <br />
            United Kingdom
          </div>

          <div className="packing-line" />

          <div className="packing-section-title">Ship To</div>
          <div className="packing-from">
            <strong>{invoice.customerName || "Walk-in customer"}</strong>
            <br />
            {invoice.customerEmail || "-"}
            <br />
            {invoice.customerPhone || "-"}
            <br />
            {invoice.address1 || "-"}
            <br />
            {invoice.address2 || ""}
            {invoice.address2 ? <br /> : null}
            {`${invoice.city || ""} ${invoice.county || ""}`.trim() || "-"}
            <br />
            {invoice.postcode || "-"}
            <br />
            {invoice.country || "-"}
            <br />
            Shipping: {invoice.shippingMethod || "Collection"}
            <br />
            Fulfillment: {invoice.fulfillmentStatus || "-"}
            <br />
            Delivery: {invoice.deliveryStatus || "-"}
            <br />
            Type: {invoice.deliveryMethod || "-"}
            <br />
            Carrier: {invoice.carrierName || "-"}
            <br />
            Tracking: {invoice.trackingNumber || "-"}
            <br />
            Tracking URL: {invoice.trackingUrl || "-"}
          </div>

          <div className="packing-line" />

          <div className="packing-section-title">Order Details</div>

          <table className="packing-table">
            <thead>
              <tr>
                <th style={{ width: 55 }}>Qty</th>
                <th style={{ width: 90 }}>Image</th>
                <th>Item</th>
                <th style={{ width: 120 }}>Location</th>
                <th style={{ width: 90 }}>Picked</th>
              </tr>
            </thead>

            <tbody>
              {invoice.lineItems.length > 0 ? (
                invoice.lineItems.map((item: any) => (
                  <tr key={`packing-${item.id}`}>
                    <td style={{ textAlign: "center", fontWeight: 700 }}>
                      {item.quantity}
                    </td>

                    <td style={{ textAlign: "center" }}>
                      {item.imageUrl ? (
                        <img
                          src={item.imageUrl}
                          alt={item.title}
                          className="packing-img"
                        />
                      ) : (
                        "-"
                      )}
                    </td>

                    <td>
                      <div className="packing-item">{item.title}</div>
                      <div className="packing-sku">SKU: {item.sku || "-"}</div>
                    </td>

                    <td style={{ textAlign: "center" }}>—</td>
                    <td style={{ textAlign: "center" }}>☐</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={5} style={{ textAlign: "center", fontWeight: 600 }}>
                    No order lines found for this invoice.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}