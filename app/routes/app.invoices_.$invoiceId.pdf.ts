import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import puppeteer from "puppeteer-core";
import { Buffer } from "node:buffer";

function money(value: any) {
  return `£${Number(value || 0).toFixed(2)}`;
}

function safe(value: any) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

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

  const logoUrl = process.env.BUSINESS_LOGO_URL || "";

  const rows = invoice.lineItems
    .map(
      (item: any) => `
        <tr>
          <td>${safe(item.title)}</td>
          <td>${safe(item.sku || "-")}</td>
          <td class="right">${safe(item.quantity)}</td>
          <td class="right">${money(item.unitPrice)}</td>
          <td class="right">${money(item.discount)}</td>
          <td class="right">${money(item.lineTotal)}</td>
        </tr>
      `,
    )
    .join("");

  const html = `
    <!doctype html>
    <html>
      <head>
        <meta charset="utf-8" />
        <title>Invoice INV-${invoice.id}</title>

        <style>
          body {
            margin: 0;
            font-family: Arial, sans-serif;
            color: #111;
            font-size: 14px;
          }

          .page {
            padding: 35px;
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
        </style>
      </head>

      <body>
        <div class="page">
          <div class="header">
            <div>
              <h1>Invoice INV-${invoice.id}</h1>
              <p class="muted">Date: ${safe(
                new Date(invoice.createdAt).toLocaleString("en-GB"),
              )}</p>
              <p>Salesperson: ${safe(invoice.staff?.name || "-")}</p>
              <p>Payment method: ${safe(invoice.paymentMethod)}</p>
              <p>Reference: ${safe(invoice.reference || "-")}</p>
            </div>

            <div class="business">
              ${
                logoUrl
                  ? `<img src="${safe(
                      logoUrl,
                    )}" alt="NII Clean Products logo" class="logo" />`
                  : ""
              }

              <h2>NII Clean Products</h2>
              <p>96 Bushmills Road</p>
              <p>Coleraine / BT52 2BT</p>
              <p>Email: sales@niicleanproducts.com</p>
              <p>VAT No: 369865135</p>
            </div>
          </div>

          <div class="grid">
            <div class="box">
              <h3>Customer</h3>
              <p>${safe(invoice.customerName)}</p>
              <p>${safe(invoice.customerEmail || "")}</p>
              <p>${safe(invoice.customerPhone || "")}</p>
              <p>VAT Number: ${safe(invoice.customerVatNumber || "-")}</p>
            </div>

            <div class="box">
              <h3>Shipping Address</h3>
              <p>${safe(invoice.address1 || "")}</p>
              <p>${safe(invoice.address2 || "")}</p>
              <p>${safe(invoice.city || "")} ${safe(invoice.county || "")}</p>
              <p>${safe(invoice.postcode || "")}</p>
              <p>${safe(invoice.country || "")}</p>
            </div>
          </div>

          <table>
            <thead>
              <tr>
                <th>Item</th>
                <th>SKU</th>
                <th class="right">Qty</th>
                <th class="right">Unit</th>
                <th class="right">Discount</th>
                <th class="right">Total</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>

          <div class="totals">
            <div class="totals-row">
              <span>Subtotal</span>
              <span>${money(invoice.subtotal)}</span>
            </div>

            <div class="totals-row">
              <span>Discount</span>
              <span>${money(invoice.discountTotal)}</span>
            </div>

            <div class="totals-row">
              <span>VAT</span>
              <span>${money(invoice.vatAmount)}</span>
            </div>

            <div class="totals-row grand-total">
              <span>Total</span>
              <span>${money(invoice.total)}</span>
            </div>
          </div>

          <div class="footer">Thank you for your business.</div>
        </div>
      </body>
    </html>
  `;

const browser = await puppeteer.launch({
  headless: true,
  executablePath:
    process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium-browser",
  args: [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
  ],
});

  try {
    const page = await browser.newPage();

    await page.setContent(html, {
      waitUntil: "networkidle0",
    });

    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: {
        top: "12mm",
        right: "10mm",
        bottom: "12mm",
        left: "10mm",
      },
    });

    return new Response(Buffer.from(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="Invoice-INV-${invoice.id}.pdf"`,
      },
    });
  } finally {
    await browser.close();
  }
}