import { useMemo, useState } from "react";
import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { invoiceId: string };
}) {
  await authenticate.admin(request);

  const invoice = await prisma.sale.findUnique({
    where: { id: Number(params.invoiceId) },
    include: {
      staff: true,
      lineItems: true,
    },
  });

  if (!invoice) {
    throw new Response("Invoice not found", { status: 404 });
  }

  return {
    invoice,
    logoUrl: process.env.BUSINESS_LOGO_URL || "",
  };
}

type CustomItem = {
  id: number;
  title: string;
  sku: string;
  quantity: number;
  unitPrice: number;
  discount: number;
};

export default function PrintInvoicePage() {
  const { invoice, logoUrl } = useLoaderData<typeof loader>();

  const [amountPaid, setAmountPaid] = useState(0);
  const [depositPaid, setDepositPaid] = useState(false);

  const [customItems, setCustomItems] = useState<CustomItem[]>([]);
  const [customTitle, setCustomTitle] = useState("");
  const [customSku, setCustomSku] = useState("");
  const [customQty, setCustomQty] = useState(1);
  const [customUnitPrice, setCustomUnitPrice] = useState(0);
  const [customDiscount, setCustomDiscount] = useState(0);

  const customItemsTotal = useMemo(() => {
    return customItems.reduce((sum, item) => {
      return sum + item.quantity * item.unitPrice - item.discount;
    }, 0);
  }, [customItems]);

  const adjustedSubtotal = Number(invoice.subtotal) + customItemsTotal;
  const adjustedTotal = Number(invoice.total) + customItemsTotal;
  const remainingBalance = Math.max(adjustedTotal - amountPaid, 0);

  function money(value: number | string) {
    return `£${Number(value || 0).toFixed(2)}`;
  }

  function addCustomItem() {
    if (!customTitle.trim()) return;

    setCustomItems((items) => [
      ...items,
      {
        id: Date.now(),
        title: customTitle,
        sku: customSku,
        quantity: Number(customQty || 1),
        unitPrice: Number(customUnitPrice || 0),
        discount: Number(customDiscount || 0),
      },
    ]);

    setCustomTitle("");
    setCustomSku("");
    setCustomQty(1);
    setCustomUnitPrice(0);
    setCustomDiscount(0);
  }

  function removeCustomItem(id: number) {
    setCustomItems((items) => items.filter((item) => item.id !== id));
  }

  function downloadPdf(event?: React.MouseEvent<HTMLButtonElement>) {
    event?.preventDefault();
    event?.stopPropagation();

    const pdfUrl =
      window.location.pathname.replace(/\/$/, "") +
      "/pdf" +
      window.location.search;

    const link = document.createElement("a");
    link.href = pdfUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.download = `Invoice-INV-${invoice.id}.pdf`;

    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  return (
    <div className="screen">
      <style>{`
        body {
          margin: 0;
          background: #eef0f3;
          font-family: Arial, sans-serif;
          color: #111827;
        }

        .screen {
          padding: 28px;
        }

        .actions {
          max-width: 980px;
          margin: 0 auto 20px;
          background: white;
          border: 1px solid #d9dee7;
          border-radius: 14px;
          padding: 18px;
          box-shadow: 0 8px 24px rgba(15, 23, 42, 0.08);
        }

        .action-row {
          display: flex;
          flex-wrap: wrap;
          gap: 10px;
          margin-bottom: 16px;
        }

        button {
          padding: 10px 16px;
          cursor: pointer;
          border: 1px solid #111827;
          background: #111827;
          color: white;
          border-radius: 8px;
          font-weight: 700;
        }

        button.secondary {
          background: white;
          color: #111827;
        }

        button.danger {
          background: #7f1d1d;
          border-color: #7f1d1d;
        }

        .controls-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 18px;
        }

        .control-card {
          border: 1px solid #e5e7eb;
          border-radius: 12px;
          padding: 14px;
          background: #fafafa;
        }

        .control-card h3 {
          margin: 0 0 12px;
          font-size: 15px;
        }

        .form-grid {
          display: grid;
          grid-template-columns: 2fr 1fr 0.7fr 1fr 1fr;
          gap: 8px;
          margin-bottom: 10px;
        }

        input {
          width: 100%;
          box-sizing: border-box;
          padding: 9px;
          border: 1px solid #cfd5df;
          border-radius: 8px;
        }

        label {
          display: flex;
          gap: 8px;
          align-items: center;
          font-size: 14px;
        }

        label input {
          width: auto;
        }

        .invoice {
          max-width: 980px;
          margin: 0 auto;
          background: white;
          border-radius: 16px;
          overflow: hidden;
          box-shadow: 0 12px 34px rgba(15, 23, 42, 0.12);
        }

        .topbar {
          background: #111827;
          color: white;
          padding: 34px 42px;
          display: flex;
          justify-content: space-between;
          gap: 30px;
        }

        .invoice-title h1 {
          margin: 0;
          font-size: 38px;
          letter-spacing: 1px;
        }

        .invoice-title p {
          margin: 8px 0 0;
          color: #d1d5db;
        }

        .business {
          text-align: right;
          max-width: 310px;
        }

        .logo {
          max-width: 190px;
          max-height: 80px;
          object-fit: contain;
          margin-bottom: 12px;
          background: white;
          padding: 8px;
          border-radius: 8px;
        }

        .business h2 {
          margin: 0 0 8px;
        }

        .business p,
        .meta p,
        .box p {
          margin: 4px 0;
        }

        .content {
          padding: 38px 42px;
        }

        .summary-strip {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          border: 1px solid #e5e7eb;
          border-radius: 14px;
          overflow: hidden;
          margin-bottom: 28px;
        }

        .summary-item {
          padding: 16px;
          border-right: 1px solid #e5e7eb;
          background: #f9fafb;
        }

        .summary-item:last-child {
          border-right: 0;
        }

        .label {
          display: block;
          color: #6b7280;
          font-size: 12px;
          text-transform: uppercase;
          letter-spacing: .06em;
          margin-bottom: 6px;
        }

        .value {
          font-weight: 700;
        }

        .paid {
          color: #166534;
        }

        .due {
          color: #991b1b;
        }

        .grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 22px;
          margin-bottom: 30px;
        }

        .box {
          border: 1px solid #e5e7eb;
          padding: 20px;
          border-radius: 14px;
        }

        .box h3 {
          margin: 0 0 14px;
          font-size: 14px;
          color: #374151;
          text-transform: uppercase;
          letter-spacing: .06em;
        }

        table {
          width: 100%;
          border-collapse: collapse;
          margin-top: 18px;
        }

        th {
          background: #111827;
          color: white;
          text-align: left;
          padding: 13px;
          font-size: 13px;
        }

        td {
          padding: 14px 13px;
          border-bottom: 1px solid #e5e7eb;
          vertical-align: top;
        }

        .right {
          text-align: right;
        }

        .item-title {
          font-weight: 700;
        }

        .custom-badge {
          display: inline-block;
          margin-left: 8px;
          padding: 2px 7px;
          border-radius: 999px;
          background: #e0f2fe;
          color: #075985;
          font-size: 11px;
          font-weight: 700;
        }

        .totals-wrap {
          display: flex;
          justify-content: flex-end;
          margin-top: 30px;
        }

        .totals {
          width: 390px;
          border: 1px solid #e5e7eb;
          border-radius: 14px;
          overflow: hidden;
        }

        .totals-row {
          display: flex;
          justify-content: space-between;
          padding: 12px 16px;
          border-bottom: 1px solid #e5e7eb;
        }

        .totals-row:last-child {
          border-bottom: 0;
        }

        .grand-total {
          background: #111827;
          color: white;
          font-weight: bold;
          font-size: 19px;
        }

        .balance {
          background: #fef2f2;
          color: #991b1b;
          font-weight: 800;
        }

        .footer {
          margin-top: 48px;
          border-top: 1px solid #e5e7eb;
          padding-top: 18px;
          display: flex;
          justify-content: space-between;
          gap: 20px;
          color: #6b7280;
          font-size: 13px;
        }

        @media print {
          body {
            background: white;
          }

          .screen {
            padding: 0;
          }

          .actions {
            display: none;
          }

          .invoice {
            box-shadow: none;
            border-radius: 0;
            max-width: none;
          }

          .custom-remove {
            display: none;
          }
        }
      `}</style>

      <div className="actions">
        <div className="action-row">
          <button type="button" onClick={() => window.print()}>
            Print Invoice
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

        <div className="controls-grid">
          <div className="control-card">
            <h3>Payment Details</h3>

            <input
              type="number"
              min="0"
              step="0.01"
              value={amountPaid}
              onChange={(event) => setAmountPaid(Number(event.target.value))}
              placeholder="Amount paid"
            />

            <br />
            <br />

            <label>
              <input
                type="checkbox"
                checked={depositPaid}
                onChange={(event) => setDepositPaid(event.target.checked)}
              />
              Mark deposit as paid
            </label>
          </div>

          <div className="control-card">
            <h3>Add Custom Invoice Item</h3>

            <div className="form-grid">
              <input
                value={customTitle}
                onChange={(event) => setCustomTitle(event.target.value)}
                placeholder="Item name"
              />

              <input
                value={customSku}
                onChange={(event) => setCustomSku(event.target.value)}
                placeholder="SKU"
              />

              <input
                type="number"
                min="1"
                value={customQty}
                onChange={(event) => setCustomQty(Number(event.target.value))}
                placeholder="Qty"
              />

              <input
                type="number"
                min="0"
                step="0.01"
                value={customUnitPrice}
                onChange={(event) =>
                  setCustomUnitPrice(Number(event.target.value))
                }
                placeholder="Unit"
              />

              <input
                type="number"
                min="0"
                step="0.01"
                value={customDiscount}
                onChange={(event) =>
                  setCustomDiscount(Number(event.target.value))
                }
                placeholder="Discount"
              />
            </div>

            <button type="button" onClick={addCustomItem}>
              Add Custom Item
            </button>
          </div>
        </div>
      </div>

      <div className="invoice">
        <div className="topbar">
          <div className="invoice-title">
            <h1>INVOICE</h1>
            <p>INV-{invoice.id}</p>
          </div>

          <div className="business">
            {logoUrl && (
              <img
                src={logoUrl}
                alt="NII Clean Products logo"
                className="logo"
              />
            )}

            <h2>NII Clean Products</h2>
            <p>96 Bushmills Road</p>
            <p>Coleraine / BT52 2BT</p>
            <p>sales@niicleanproducts.com</p>
            <p>VAT No: 369865135</p>
          </div>
        </div>

        <div className="content">
          <div className="summary-strip">
            <div className="summary-item">
              <span className="label">Invoice Date</span>
              <span className="value">
                {new Date(invoice.createdAt).toLocaleString("en-GB")}
              </span>
            </div>

            <div className="summary-item">
              <span className="label">Salesperson</span>
              <span className="value">{invoice.staff?.name || "-"}</span>
            </div>

            <div className="summary-item">
              <span className="label">Payment Method</span>
              <span className="value">{invoice.paymentMethod || "-"}</span>
            </div>

            <div className="summary-item">
              <span className="label">Payment Status</span>
              <span className={remainingBalance <= 0 ? "value paid" : "value due"}>
                {remainingBalance <= 0
                  ? "Paid"
                  : depositPaid
                    ? "Deposit Paid"
                    : "Balance Due"}
              </span>
            </div>
          </div>

          <div className="grid">
            <div className="box">
              <h3>Bill To</h3>
              <p><strong>{invoice.customerName}</strong></p>
              <p>{invoice.customerEmail || ""}</p>
              <p>{invoice.customerPhone || ""}</p>
              <p>VAT Number: {invoice.customerVatNumber || "-"}</p>
            </div>

            <div className="box">
              <h3>Shipping Address</h3>
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
                <th className="custom-remove"></th>
              </tr>
            </thead>

            <tbody>
              {invoice.lineItems.map((item: any) => (
                <tr key={item.id}>
                  <td>
                    <span className="item-title">{item.title}</span>
                  </td>
                  <td>{item.sku || "-"}</td>
                  <td className="right">{item.quantity}</td>
                  <td className="right">{money(item.unitPrice)}</td>
                  <td className="right">{money(item.discount)}</td>
                  <td className="right">{money(item.lineTotal)}</td>
                  <td className="custom-remove"></td>
                </tr>
              ))}

              {customItems.map((item) => {
                const lineTotal =
                  item.quantity * item.unitPrice - item.discount;

                return (
                  <tr key={item.id}>
                    <td>
                      <span className="item-title">{item.title}</span>
                      <span className="custom-badge">Custom</span>
                    </td>
                    <td>{item.sku || "-"}</td>
                    <td className="right">{item.quantity}</td>
                    <td className="right">{money(item.unitPrice)}</td>
                    <td className="right">{money(item.discount)}</td>
                    <td className="right">{money(lineTotal)}</td>
                    <td className="right custom-remove">
                      <button
                        type="button"
                        className="danger"
                        onClick={() => removeCustomItem(item.id)}
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <div className="totals-wrap">
            <div className="totals">
              <div className="totals-row">
                <span>Subtotal</span>
                <span>{money(adjustedSubtotal)}</span>
              </div>

              <div className="totals-row">
                <span>Discount</span>
                <span>{money(invoice.discountTotal)}</span>
              </div>

              <div className="totals-row">
                <span>VAT</span>
                <span>{money(invoice.vatAmount)}</span>
              </div>

              <div className="totals-row grand-total">
                <span>Total</span>
                <span>{money(adjustedTotal)}</span>
              </div>

              <div className="totals-row">
                <span>Amount Paid</span>
                <span>{money(amountPaid)}</span>
              </div>

              <div className="totals-row balance">
                <span>Balance Remaining</span>
                <span>{money(remainingBalance)}</span>
              </div>
            </div>
          </div>

          <div className="footer">
            <span>Thank you for your business.</span>
            <span>Reference: {invoice.reference || "-"}</span>
          </div>
        </div>
      </div>
    </div>
  );
}