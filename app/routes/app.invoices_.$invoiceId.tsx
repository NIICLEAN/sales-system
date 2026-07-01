import { useEffect, useState } from "react";
import { useLoaderData, useSearchParams } from "react-router";
import { Banner } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

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

    const [staff, lineItems] = await Promise.all([
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
          quantity: true,
          unitPrice: true,
          discount: true,
          lineTotal: true,
        },
      }),
    ]);

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
      paymentSummary,
      lineItems: lineItems.map((item) => ({
        ...item,
        imageUrl: null,
      })),
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
  const [manualPrintMode, setManualPrintMode] = useState<"invoice" | "both">(
    printMode === "both" ? "both" : "invoice",
  );
  const [pendingManualPrint, setPendingManualPrint] = useState(false);

  const effectivePrintMode = autoprintEnabled
    ? printMode === "both" || printMode === "packing" || printMode === "invoice"
      ? printMode
      : "invoice"
    : manualPrintMode;

  const packingOnlyPrint = effectivePrintMode === "packing";
  const showInvoiceSheet = !packingOnlyPrint;

  const shouldPrintPackingSlip =
    packingOnlyPrint ||
    effectivePrintMode === "both" ||
    (effectivePrintMode !== "invoice" &&
      (fulfilmentMethod === "Collecting" || fulfilmentMethod === "Delivery"));

  useEffect(() => {
    if (searchParams.get("autoprint") !== "1") return;

    const timer = window.setTimeout(() => {
      window.print();
    }, 500);

    return () => window.clearTimeout(timer);
  }, [searchParams]);

  function printWithMode(mode: "invoice" | "both") {
    setManualPrintMode(mode);
    setPendingManualPrint(true);
  }

  useEffect(() => {
    if (!pendingManualPrint || autoprintEnabled) return;

    // Give the browser time to paint the selected print mode before opening print.
    const timer = window.setTimeout(() => {
      setPendingManualPrint(false);
      window.print();
    }, 250);

    return () => window.clearTimeout(timer);
  }, [pendingManualPrint, autoprintEnabled, manualPrintMode]);

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
    <div className="page">
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

        .actions {
          margin-bottom: 30px;
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
          grid-template-columns: repeat(4, 1fr);
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
          body {
            background: white;
          }

          .page {
            margin: 0;
            max-width: none;
            box-shadow: none;
            padding: 25px;
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

        <button type="button" onClick={downloadPdf}>
          Download PDF
        </button>

        <button
          type="button"
          className="secondary"
          onClick={() => window.history.back()}
        >
          Back
        </button>
      </div>

      {showInvoiceSheet ? (
      <>
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
      </>
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
              {invoice.lineItems.map((item: any) => (
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
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}