import { useEffect } from "react";
import { Form, redirect, useLoaderData, useSearchParams } from "react-router";
import { Banner } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
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
  await authenticate.admin(request);

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
      const { admin } = await authenticate.admin(request);

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
        return redirect(withEmbeddedParamsFromRequest(request, `/app/invoices/${invoiceId}?labelStatus=error&labelMessage=${encodeURIComponent("Invoice not found")}`));
      }

      if (sale.shopifyOrderId) {
        return redirect(withEmbeddedParamsFromRequest(request, `/app/invoices/${invoiceId}?labelStatus=error&labelMessage=${encodeURIComponent("This invoice already has an NCP number")}`));
      }

      if (String(sale.paymentStatus || "").toLowerCase() !== "paid") {
        return redirect(withEmbeddedParamsFromRequest(request, `/app/invoices/${invoiceId}?labelStatus=error&labelMessage=${encodeURIComponent("NCP numbers are only generated for paid invoices")}`));
      }

      const isVatExempt = Boolean(sale.customerVatNumber);

      const draftOrderInput: any = {
        customerId: sale.customerId || undefined,
        email: sale.customerEmail || undefined,
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
        return redirect(withEmbeddedParamsFromRequest(request, `/app/invoices/${invoiceId}?labelStatus=error&labelMessage=${encodeURIComponent(createErrors.map((e: any) => e.message).join(", "))}`));
      }

      const draftOrderId = createDraftJson.data.draftOrderCreate.draftOrder.id;

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
        return redirect(withEmbeddedParamsFromRequest(request, `/app/invoices/${invoiceId}?labelStatus=error&labelMessage=${encodeURIComponent(completeErrors.map((e: any) => e.message).join(", "))}`));
      }

      const shopifyOrder = completeDraftJson.data.draftOrderComplete.draftOrder.order;

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

    const fallbackAmountPaid = Number(sale.amountPaid || 0);

    const paymentSummary = {
      count: recordedPaymentCount || (fallbackAmountPaid > 0 ? 1 : 0),
      total: recordedPaymentTotal || fallbackAmountPaid,
      isEstimated: recordedPaymentCount === 0 && fallbackAmountPaid > 0,
    };

    const invoice = {
      ...sale,
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
      lineItems,
    };

    return {
      invoice,
      logoUrl: process.env.BUSINESS_LOGO_URL || "",
      error: null,
    };
  } catch (error) {
    if (error instanceof Response) throw error;
    console.error("Failed to load invoice:", error);
    return {
      invoice: null,
      logoUrl: "",
      error: "Invoice could not be loaded right now.",
    };
  }
}

export default function PrintInvoicePage() {
  const { invoice, logoUrl, error } = useLoaderData<typeof loader>();
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

  function downloadPdf(event?: React.MouseEvent<HTMLButtonElement>) {
    event?.preventDefault();
    event?.stopPropagation();

    const pdfUrl = withEmbeddedParams(window.location.pathname.replace(/\/$/, "") + "/pdf");

    const link = document.createElement("a");
    link.href = pdfUrl;
    link.download = `Invoice-INV-${loadedInvoice.id}.pdf`;

    document.body.appendChild(link);
    link.click();
    link.remove();
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

        <button type="button" onClick={downloadPdf}>
          Download PDF
        </button>

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
      <div className="header">
        <div>
          <h1 className="invoice-title">Invoice</h1>
          <div className="invoice-number">INV-{invoice.id}</div>
        </div>

        <div className="business">
          {logoUrl && <img src={logoUrl} alt="Logo" className="logo" />}

          <h2>NII Clean Products</h2>
          <p>96 Bushmills Road</p>
          <p>Coleraine / BT52 2BT</p>
          <p>sales@niicleanproducts.com</p>
          <p>VAT No: 369865135</p>
        </div>
      </div>

      <div className="meta-grid">
        <div className="meta-cell">
          <div className="label">Invoice Date</div>
          <div className="value">
            {formatDateTime(invoice.createdAt)}
          </div>
        </div>

        <div className="meta-cell">
          <div className="label">Salesperson</div>
          <div className="value">{invoice.staff?.name || "-"}</div>
        </div>

        <div className="meta-cell">
          <div className="label">Payment Method</div>
          <div className="value">{invoice.paymentMethod}</div>
        </div>

        <div className="meta-cell">
          <div className="label">Payment Status</div>
          <div
            className={`value ${
              paymentStatus === "Paid"
                ? "status-paid"
                : paymentStatus === "Partially Paid"
                  ? "status-partial"
                  : "status-unpaid"
            }`}
          >
            {paymentStatus}
          </div>
        </div>

        <div className="meta-cell">
          <div className="label">Invoice Discount</div>
          <div className="value">
            {invoice.invoiceDiscountType === "percent"
              ? `${invoice.invoiceDiscountValue || 0}%`
              : money(invoice.invoiceDiscountAmount || 0)}
          </div>
        </div>

        <div className="meta-cell">
          <div className="label">Shipping</div>
          <div className="value">{invoice.shippingMethod || "Collection"}</div>
          <div style={{ marginTop: 4, fontSize: 12, color: "#4b5870" }}>
            Fulfillment: {invoice.fulfillmentStatus || "-"}
          </div>
          <div style={{ marginTop: 4, fontSize: 12, color: "#4b5870" }}>
            Delivery: {invoice.deliveryStatus || "-"}
          </div>
          <div style={{ marginTop: 4, fontSize: 12, color: "#4b5870" }}>
            Type: {invoice.deliveryMethod || "-"}
          </div>
          <div style={{ marginTop: 4, fontSize: 12, color: "#4b5870" }}>
            Carrier: {invoice.carrierName || "-"}
          </div>
          <div style={{ marginTop: 4, fontSize: 12, color: "#4b5870" }}>
            Tracking: {invoice.trackingNumber || "-"}
          </div>
          {invoice.trackingUrl ? (
            <div style={{ marginTop: 4, fontSize: 12 }}>
              <a href={invoice.trackingUrl} target="_blank" rel="noreferrer">Track shipment</a>
            </div>
          ) : null}
        </div>
      </div>

      <div className="address-grid">
        <div className="address-box">
          <div className="address-title">Bill To</div>
          <p>
            <strong>{invoice.customerName}</strong>
          </p>
          <p>{invoice.customerEmail || ""}</p>
          <p>{invoice.customerPhone || ""}</p>
          <p>VAT Number: {invoice.customerVatNumber || "-"}</p>
        </div>

        <div className="address-box">
          <div className="address-title">Shipping Address</div>
          <p>{invoice.address1 || ""}</p>
          <p>{invoice.address2 || ""}</p>
          <p>
            {invoice.city || ""} {invoice.county || ""}
          </p>
          <p>{invoice.postcode || ""}</p>
          <p>{invoice.country || ""}</p>
        </div>
      </div>

      <table>
        <thead>
          <tr>
            <th>Item Description</th>
            <th>SKU</th>
            <th className="right">Qty</th>
            <th className="right">Unit Price</th>
            <th className="right">Discount</th>
            <th className="right">Line Total</th>
          </tr>
        </thead>

        <tbody>
          {invoice.lineItems.map((item: any) => (
            <tr key={item.id}>
              <td>{item.title}</td>
              <td>{item.sku || "-"}</td>
              <td className="right">{item.quantity}</td>
              <td className="right">{money(item.unitPrice)}</td>
              <td className="right">{money(item.discount)}</td>
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
          <span>Discount</span>
          <span>{money(invoice.discountTotal)}</span>
        </div>

        <div className="totals-row">
          <span>Invoice Discount</span>
          <span>-{money(invoice.invoiceDiscountAmount || 0)}</span>
        </div>

        <div className="totals-row">
          <span>VAT</span>
          <span>{money(invoice.vatAmount)}</span>
        </div>

        <div className="totals-row total-row">
          <span>Total</span>
          <span>{money(invoice.total)}</span>
        </div>

        <div className="totals-row paid-row">
          <span>Amount Paid</span>
          <span>{money(amountPaid)}</span>
        </div>

        <div className="totals-row payments-row">
          <span>
            Partial Payments Made ({partialPaymentCount})
            {partialPaymentEstimated ? (
              <span className="payments-note">Based on recorded amount paid</span>
            ) : null}
          </span>
          <span>
            {money(partialPaymentTotal)} / {money(invoice.total)}
          </span>
        </div>

        <div className="totals-row balance-row">
          <span>Balance Remaining</span>
          <span>{money(balanceDue)}</span>
        </div>
      </div>

      <div className="footer">Thank you for your business.</div>
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