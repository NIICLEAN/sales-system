import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { quoteId: string };
}) {
  await authenticate.admin(request);

  const quote = await prisma.quote.findUnique({
    where: { id: Number(params.quoteId) },
    include: {
      staff: true,
      lineItems: true,
    },
  });

  if (!quote) {
    throw new Response("Quote not found", { status: 404 });
  }

  return { quote };
}

export default function PrintQuotePage() {
  const { quote } = useLoaderData<typeof loader>();

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
          padding: 8px 14px;
          margin-right: 8px;
          cursor: pointer;
        }

        .header {
          display: flex;
          justify-content: space-between;
          border-bottom: 3px solid #111;
          padding-bottom: 25px;
          margin-bottom: 30px;
        }

        h1 {
          font-size: 34px;
          margin: 0 0 10px;
        }

        h2 {
          margin: 0 0 10px;
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

          .actions {
            display: none;
          }
        }
      `}</style>

      <div className="actions">
        <button onClick={() => window.print()}>Print Quote</button>
        <button onClick={() => window.history.back()}>Back</button>
      </div>

      <div className="header">
        <div>
          <h1>Quote QUO-{quote.id}</h1>
          <p className="muted">Date: {new Date(quote.createdAt).toLocaleString()}</p>
          <p>Salesperson: {quote.staff?.name || "-"}</p>
          <p>Reference: {quote.reference || "-"}</p>
        </div>

        <div>
          <h2>Your Company Name</h2>
          <p>Your address line 1</p>
          <p>Your town / postcode</p>
          <p>Email: sales@example.com</p>
          <p>VAT No: YOUR VAT NUMBER</p>
        </div>
      </div>

      <div className="grid">
        <div className="box">
          <h3>Customer</h3>
          <p>{quote.customerName}</p>
          <p>{quote.customerEmail || ""}</p>
          <p>{quote.customerPhone || ""}</p>
        </div>

        <div className="box">
          <h3>Address</h3>
          <p>{quote.address1 || ""}</p>
          <p>{quote.address2 || ""}</p>
          <p>{quote.city || ""} {quote.county || ""}</p>
          <p>{quote.postcode || ""}</p>
          <p>{quote.country || ""}</p>
        </div>
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
          {quote.lineItems.map((item: any) => (
            <tr key={item.id}>
              <td>{item.title}</td>
              <td>{item.sku || "-"}</td>
              <td className="right">{item.quantity}</td>
              <td className="right">£{item.unitPrice.toFixed(2)}</td>
              <td className="right">£{item.discount.toFixed(2)}</td>
              <td className="right">£{item.lineTotal.toFixed(2)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="totals">
        <div className="totals-row">
          <span>Subtotal</span>
          <span>£{quote.subtotal.toFixed(2)}</span>
        </div>

        <div className="totals-row">
          <span>Discount</span>
          <span>£{quote.discountTotal.toFixed(2)}</span>
        </div>

        <div className="totals-row">
          <span>VAT</span>
          <span>£{quote.vatAmount.toFixed(2)}</span>
        </div>

        <div className="totals-row grand-total">
          <span>Total</span>
          <span>£{quote.total.toFixed(2)}</span>
        </div>
      </div>

      <div className="footer">
        This quote is valid subject to stock availability.
      </div>
    </div>
  );
}