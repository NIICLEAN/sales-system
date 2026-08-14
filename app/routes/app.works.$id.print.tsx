import { useEffect } from "react";
import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { id: string };
}) {
  await authenticate.admin(request);

  const worksOrder = await prisma.worksOrder.findUnique({
    where: { id: Number(params.id) },
    include: {
      lineItems: true,
    },
  });

  if (!worksOrder) {
    throw new Response("Works order not found", { status: 404 });
  }

  const salesperson = await prisma.staff.findUnique({
    where: { id: worksOrder.salespersonId },
  });

  const assignedStaff = worksOrder.assignedStaffId
    ? await prisma.staff.findUnique({
        where: { id: worksOrder.assignedStaffId },
      })
    : null;

  return {
    worksOrder,
    salesperson,
    assignedStaff,
    logoUrl: process.env.BUSINESS_LOGO_URL || "",
  };
}

export default function PrintWorksOrderPage() {
  const { worksOrder, salesperson, assignedStaff, logoUrl } =
    useLoaderData<typeof loader>();

    useEffect(() => {
  const timer = window.setTimeout(() => {
    window.print();
  }, 500);

  return () => window.clearTimeout(timer);
}, []);

  function formatCurrency(value: any) {
    return `£${Number(value ?? 0).toFixed(2)}`;
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
    link.download = `Works-Order-${worksOrder.id}.pdf`;

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
          border: 1px solid #111;
          background: #111;
          color: white;
          border-radius: 6px;
          font-weight: 600;
        }

        button.secondary {
          background: white;
          color: #111;
        }

        .header {
          display: flex;
          justify-content: space-between;
          gap: 30px;
          border-bottom: 3px solid #111;
          padding-bottom: 25px;
          margin-bottom: 30px;
        }

        .business {
          text-align: right;
          min-width: 260px;
        }

        .logo {
          max-width: 190px;
          max-height: 90px;
          object-fit: contain;
          margin-bottom: 12px;
        }

        h1 {
          font-size: 34px;
          margin: 0 0 10px;
        }

        h2 {
          margin: 0 0 10px;
        }

        p {
          margin: 4px 0;
        }

        .muted {
          color: #555;
        }

        .grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 30px;
          margin-bottom: 30px;
        }

        .box {
          border: 1px solid #ddd;
          padding: 18px;
          border-radius: 8px;
        }

        .box h3 {
          margin-top: 0;
          border-bottom: 1px solid #eee;
          padding-bottom: 8px;
        }

        .notes {
          white-space: pre-wrap;
          min-height: 60px;
        }

        table {
          width: 100%;
          border-collapse: collapse;
          margin-top: 25px;
        }

        th {
          background: #f1f1f1;
          text-align: left;
          padding: 12px;
          font-size: 14px;
        }

        td {
          padding: 12px;
          border-bottom: 1px solid #e5e5e5;
          vertical-align: top;
        }

        .right {
          text-align: right;
        }

        .totals {
          width: 340px;
          margin-left: auto;
          margin-top: 30px;
          border: 1px solid #ddd;
          border-radius: 8px;
          padding: 15px;
        }

        .totals-row {
          display: flex;
          justify-content: space-between;
          padding: 7px 0;
        }

        .grand-total {
          border-top: 2px solid #111;
          margin-top: 8px;
          padding-top: 12px;
          font-weight: bold;
          font-size: 20px;
        }

        .footer {
          margin-top: 50px;
          font-size: 13px;
          color: #555;
          border-top: 1px solid #ddd;
          padding-top: 15px;
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
        }
      `}</style>

      <div className="actions">
        <button type="button" onClick={() => window.print()}>
          Print Works Order
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

      <div className="header">
        <div>
          <h1>Works Order WO-{worksOrder.id}</h1>
          <p className="muted">
            Date: {new Date(worksOrder.createdAt).toLocaleString("en-GB")}
          </p>
          <p>Salesperson: {salesperson?.name || "-"}</p>
          <p>Assigned staff: {assignedStaff?.name || "-"}</p>
          <p>Service type: {worksOrder.serviceType}</p>
          <p>Payment method: {worksOrder.paymentMethod}</p>
          <p>Payment status: {worksOrder.paymentStatus}</p>
        </div>

        <div className="business">
          {logoUrl && (
            <img src={logoUrl} alt="NII Clean Products logo" className="logo" />
          )}

          <h2>NII Clean Products</h2>
          <p>96 Bushmills Road</p>
          <p>Coleraine / BT52 2BT</p>
          <p>Email: sales@niicleanproducts.com</p>
          <p>VAT No: 369865135</p>
        </div>
      </div>

      <div className="grid">
        <div className="box">
          <h3>Customer</h3>
          <p>{worksOrder.customerName}</p>
          <p>{worksOrder.customerEmail || ""}</p>
          <p>{worksOrder.customerPhone || ""}</p>
          <p>VAT Number: {worksOrder.customerVatNumber || "-"}</p>
        </div>

        <div className="box">
          <h3>Job / Shipping Address</h3>
          <p>{worksOrder.address1 || ""}</p>
          <p>{worksOrder.address2 || ""}</p>
          <p>
            {worksOrder.city || ""} {worksOrder.county || ""}
          </p>
          <p>{worksOrder.postcode || ""}</p>
          <p>{worksOrder.country || ""}</p>
        </div>
      </div>

      <div className="box">
        <h3>Extra Information</h3>
        <p className="notes">{worksOrder.extraInfo || "-"}</p>
      </div>

      <table>
        <thead>
          <tr>
            <th>Item</th>
            <th>SKU</th>
            <th className="right">Qty</th>
            <th className="right">Unit</th>
            <th className="right">Discount</th>
            <th className="right">Total</th>
          </tr>
        </thead>

        <tbody>
          {worksOrder.lineItems.map((item: any) => (
            <tr key={item.id}>
              <td>{item.title}</td>
              <td>{item.sku || "-"}</td>
              <td className="right">{item.quantity}</td>
              <td className="right">{formatCurrency(item.unitPrice)}</td>
              <td className="right">{formatCurrency(item.discount)}</td>
              <td className="right">{formatCurrency(item.lineTotal)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="totals">
        <div className="totals-row">
          <span>Subtotal</span>
          <span>{formatCurrency(worksOrder.subtotal)}</span>
        </div>

        <div className="totals-row">
          <span>Discount</span>
          <span>{formatCurrency(worksOrder.discountTotal)}</span>
        </div>

        <div className="totals-row">
          <span>VAT</span>
          <span>{formatCurrency(worksOrder.vatAmount)}</span>
        </div>

        <div className="totals-row grand-total">
          <span>Total</span>
          <span>{formatCurrency(worksOrder.total)}</span>
        </div>

        <div className="totals-row">
          <span>Amount paid</span>
          <span>{formatCurrency(worksOrder.amountPaid)}</span>
        </div>

        <div className="totals-row">
          <span>Balance due</span>
          <span>
            {formatCurrency(
              Number(worksOrder.total ?? 0) - Number(worksOrder.amountPaid ?? 0)
            )}
          </span>
        </div>
      </div>

      <div className="footer">Thank you for your business.</div>
    </div>
  );
}