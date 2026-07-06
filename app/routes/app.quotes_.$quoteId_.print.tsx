import { useEffect } from "react";
import {
  useLoaderData,
  useSearchParams,
} from "react-router";
import { Banner } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { quoteId: string };
}) {
  try {
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

    return {
      quote,
      logoUrl: process.env.BUSINESS_LOGO_URL || "",
      error: null,
    };
  } catch (error) {
    if (error instanceof Response) throw error;
    console.error("Failed to load quote print page:", error);
    return {
      quote: null,
      logoUrl: "",
      error: "Quote could not be loaded right now.",
    };
  }
}

export default function PrintQuotePage() {
  const { quote, logoUrl, error } = useLoaderData<typeof loader>();

  if (error || !quote) {
    return <Banner tone="critical">{error || "Quote not found."}</Banner>;
  }

  const loadedQuote = quote;

  const [searchParams] = useSearchParams();

useEffect(() => {
  if (
    searchParams.get("autoprint") !== "1"
  )
    return;

  const timer = window.setTimeout(() => {
    window.print();
  }, 500);

  return () =>
    window.clearTimeout(timer);
}, [searchParams]);

function formatCurrency(value: any) {
  return `£${Number(value ?? 0).toFixed(2)}`;
}

async function downloadPdf(event?: React.MouseEvent<HTMLButtonElement>) {
  event?.preventDefault();
  event?.stopPropagation();

  const pdfUrl = window.location.pathname.replace(/\/$/, "") + "/pdf";

  try {
    const response = await fetch(pdfUrl);
    if (!response.ok) throw new Error(`Server returned ${response.status}`);
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = `Quote-QUO-${loadedQuote.id}.pdf`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(objectUrl);
  } catch (err) {
    console.error("PDF download failed:", err);
    alert("Failed to download PDF — please try again.");
  }
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
  background: white;
  color: #111;
  border-bottom: 3px solid #111827;
  padding-bottom: 25px;
  margin-bottom: 25px;
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
  font-size: 36px;
  letter-spacing: 1px;
  margin: 0;
  color: #111827;
  font-weight: 700;
  text-transform: uppercase;
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
  background: #111827;
  color: white;
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
  background: #111827;
  color: white;
  border-radius: 8px;
  margin-top: 12px;
  padding: 14px 10px;
  font-weight: 700;
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
        <button onClick={() => window.print()}>Print Quote</button>
        <button type="button" onClick={downloadPdf}>
  Download PDF
</button>
        <button className="secondary" onClick={() => window.history.back()}>
          Back
        </button>
      </div>

      <div className="header">
        <div>
          <h1>Quote QUO-{loadedQuote.id}</h1>
          <p className="muted">
            Date: {new Date(loadedQuote.createdAt).toLocaleString("en-GB")}
          </p>
          <p>Salesperson: {loadedQuote.staff?.name || "-"}</p>
          <p>Reference: {loadedQuote.reference || "-"}</p>
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
          <p>{loadedQuote.customerName}</p>
          <p>{loadedQuote.customerEmail || ""}</p>
          <p>{loadedQuote.customerPhone || ""}</p>
        </div>

        <div className="box">
          <h3>Address</h3>
          <p>{loadedQuote.address1 || ""}</p>
          <p>{loadedQuote.address2 || ""}</p>
          <p>
            {loadedQuote.city || ""} {loadedQuote.county || ""}
          </p>
          <p>{loadedQuote.postcode || ""}</p>
          <p>{loadedQuote.country || ""}</p>
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
          {loadedQuote.lineItems.map((item: any) => (
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
          <span>{formatCurrency(loadedQuote.subtotal)}</span>
        </div>

        <div className="totals-row">
          <span>Discount</span>
          <span>{formatCurrency(loadedQuote.discountTotal)}</span>
        </div>

        <div className="totals-row">
          <span>VAT</span>
          <span>{formatCurrency(loadedQuote.vatAmount)}</span>
        </div>

        <div className="totals-row grand-total">
          <span>Total</span>
          <span>{formatCurrency(loadedQuote.total)}</span>
        </div>
      </div>

      <div className="footer">
        This quote is valid subject to stock availability.
      </div>
    </div>
  );
}