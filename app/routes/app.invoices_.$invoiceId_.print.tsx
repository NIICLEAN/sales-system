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
  const { admin } = await authenticate.admin(request);

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

  const shopResponse = await admin.graphql(`
    query ShopBrand {
      shop {
        name
        brand {
          logo {
            image {
              url
            }
          }
        }
      }
    }
  `);

  const shopJson = await shopResponse.json();

  const logoUrl =
    shopJson.data?.shop?.brand?.logo?.image?.url || null;

  return {
    invoice,
    logoUrl,
  };
}

export default function PrintInvoicePage() {
  const { invoice, logoUrl } = useLoaderData<typeof loader>();

  function downloadPdf() {
    document.title = `Invoice INV-${invoice.id}`;
    window.print();
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

          .actions {
            display: none;
          }

          button {
            display: none;
          }
        }
      `}</style>

      <div className="actions">
        <button onClick={() => window.print()}>Print Invoice</button>
        <button onClick={downloadPdf}>Download PDF</button>
        <button className="secondary" onClick={() => window.history.back()}>
          Back
        </button>
      </div>

      <div className="header">
        <div>
          <h1>Invoice INV-{invoice.id}</h1>
          <p className="muted">
            Date: {new Date(invoice.createdAt).toLocaleString("en-GB")}
          </p>
          <p>Salesperson: {invoice.staff?.name || "-"}</p>
          <p>Payment method: {invoice.paymentMethod}</p>
          <p>Reference: {invoice.reference || "-"}</p>
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
          <p>Email: sales@niicleanproducts.com</p>
          <p>VAT No: 369865135</p>
        </div>
      </div>

      <div className="grid">
        <div className="box">
          <h3>Customer</h3>
          <p>{invoice.customerName}</p>
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
            <th>Item</th>
            <th>SKU</th>
            <th className="right">Qty</th>
            <th className="right">Unit</th>
            <th className="right">Discount</th>
            <th className="right">Total</th>
          </tr>
        </thead>

        <tbody>
          {invoice.lineItems.map((item: any) => (
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
          <span>£{invoice.subtotal.toFixed(2)}</span>
        </div>

        <div className="totals-row">
          <span>Discount</span>
          <span>£{invoice.discountTotal.toFixed(2)}</span>
        </div>

        <div className="totals-row">
          <span>VAT</span>
          <span>£{invoice.vatAmount.toFixed(2)}</span>
        </div>

        <div className="totals-row grand-total">
          <span>Total</span>
          <span>£{invoice.total.toFixed(2)}</span>
        </div>
      </div>

      <div className="footer">Thank you for your business.</div>
    </div>
  );
}