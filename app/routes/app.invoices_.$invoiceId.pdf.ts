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

  const amountPaid = Number(invoice.amountPaid || 0);
  const balanceDue =
    invoice.balanceDue !== null && invoice.balanceDue !== undefined
      ? Number(invoice.balanceDue)
      : Math.max(Number(invoice.total || 0) - amountPaid, 0);

  const paymentStatus =
    invoice.paymentStatus ||
    (amountPaid <= 0
      ? "Unpaid"
      : amountPaid < Number(invoice.total || 0)
        ? "Partially Paid"
        : "Paid");

  const statusClass =
    paymentStatus === "Paid"
      ? "status-paid"
      : paymentStatus === "Partially Paid"
        ? "status-partial"
        : "status-unpaid";

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

  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Invoice INV-${invoice.id}</title>
  <style>
    * {
      box-sizing: border-box;
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
    }

    body {
      margin: 0;
      font-family: Arial, sans-serif;
      color: #111;
      background: white;
      font-size: 13px;
    }

    .page {
      padding: 34px 42px;
      width: 100%;
    }

    .header {
      display: flex;
      justify-content: space-between;
      gap: 30px;
      background: white;
      border-bottom: 3px solid #111827;
      padding-bottom: 25px;
      margin-bottom: 25px;
    }

    .invoice-title {
      font-size: 36px;
      margin: 0;
      font-weight: 700;
      color: #111827;
      text-transform: uppercase;
      letter-spacing: 1px;
    }

    .invoice-number {
      font-size: 13px;
      color: #111827;
    }

    .business {
      text-align: right;
      font-size: 12px;
      line-height: 1.45;
      min-width: 260px;
    }

    .business h2 {
      font-size: 14px;
      margin: 8px 0 6px;
    }

    .business p {
      margin: 4px 0;
    }

    .logo {
      max-width: 180px;
      max-height: 80px;
      object-fit: contain;
      margin-bottom: 8px;
    }

    .meta-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      border: 1px solid #dfe3e8;
      border-radius: 10px;
      overflow: hidden;
      margin-bottom: 25px;
    }

    .meta-cell {
      padding: 15px;
      border-right: 1px solid #dfe3e8;
      min-height: 82px;
    }

    .meta-cell:last-child {
      border-right: none;
    }

    .label {
      font-size: 12px;
      color: #4b5870;
      text-transform: uppercase;
      letter-spacing: 1px;
      margin-bottom: 9px;
    }

    .value {
      font-weight: 700;
      line-height: 1.35;
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
      gap: 20px;
      margin-bottom: 25px;
    }

    .address-box {
      border: 1px solid #dfe3e8;
      border-radius: 10px;
      padding: 18px;
      min-height: 105px;
    }

    .address-title {
      font-size: 14px;
      text-transform: uppercase;
      letter-spacing: 1.3px;
      margin-bottom: 14px;
      color: #111827;
    }

    p {
      margin: 5px 0;
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
      padding: 11px;
      font-size: 12px;
      font-weight: 700;
    }

    td {
      padding: 12px 11px;
      border-bottom: 1px solid #e5e7eb;
      font-size: 12px;
      vertical-align: top;
    }

    .right {
      text-align: right;
    }

    .totals {
      width: 390px;
      margin-left: auto;
      margin-top: 28px;
      border: 1px solid #dfe3e8;
      border-radius: 10px;
      overflow: hidden;
    }

    .totals-row {
      display: flex;
      justify-content: space-between;
      padding: 13px 16px;
      border-bottom: 1px solid #e5e7eb;
      font-size: 13px;
    }

    .totals-row:last-child {
      border-bottom: none;
    }

    .total-row {
      background: #111827;
      color: white;
      font-weight: 700;
      font-size: 18px;
    }

    .balance-row {
      background: #ffecec;
      color: #b00020;
      font-weight: 700;
    }

    .footer {
      margin-top: 40px;
      font-size: 12px;
      color: #555;
      border-top: 1px solid #ddd;
      padding-top: 12px;
    }
  </style>
</head>

<body>
  <div class="page">
    <div class="header">
      <div>
        <h1 class="invoice-title">Invoice</h1>
        <div class="invoice-number">INV-${invoice.id}</div>
      </div>

      <div class="business">
        ${
          logoUrl
            ? `<img src="${safe(logoUrl)}" alt="NII Clean Products logo" class="logo" />`
            : ""
        }
        <h2>NII Clean Products</h2>
        <p>96 Bushmills Road</p>
        <p>Coleraine / BT52 2BT</p>
        <p>sales@niicleanproducts.com</p>
        <p>VAT No: 369865135</p>
      </div>
    </div>

    <div class="meta-grid">
      <div class="meta-cell">
        <div class="label">Invoice Date</div>
        <div class="value">${safe(new Date(invoice.createdAt).toLocaleString("en-GB"))}</div>
      </div>

      <div class="meta-cell">
        <div class="label">Salesperson</div>
        <div class="value">${safe(invoice.staff?.name || "-")}</div>
      </div>

      <div class="meta-cell">
        <div class="label">Payment Method</div>
        <div class="value">${safe(invoice.paymentMethod)}</div>
      </div>

      <div class="meta-cell">
        <div class="label">Payment Status</div>
        <div class="value ${statusClass}">${safe(paymentStatus)}</div>
      </div>
    </div>

    <div class="address-grid">
      <div class="address-box">
        <div class="address-title">Bill To</div>
        <p><strong>${safe(invoice.customerName)}</strong></p>
        <p>${safe(invoice.customerEmail || "")}</p>
        <p>${safe(invoice.customerPhone || "")}</p>
        <p>VAT Number: ${safe(invoice.customerVatNumber || "-")}</p>
      </div>

      <div class="address-box">
        <div class="address-title">Shipping Address</div>
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
          <th>Item Description</th>
          <th>SKU</th>
          <th class="right">Qty</th>
          <th class="right">Unit Price</th>
          <th class="right">Discount</th>
          <th class="right">Line Total</th>
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

      <div class="totals-row total-row">
        <span>Total</span>
        <span>${money(invoice.total)}</span>
      </div>

      <div class="totals-row">
        <span>Amount Paid</span>
        <span>${money(amountPaid)}</span>
      </div>

      <div class="totals-row balance-row">
        <span>Balance Remaining</span>
        <span>${money(balanceDue)}</span>
      </div>
    </div>

    <div class="footer">Thank you for your business.</div>
  </div>
</body>
</html>`;

  const browser = await puppeteer.launch({
    headless: true,
    executablePath:
      process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium-browser",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  try {
    const page = await browser.newPage();

    await page.setViewport({
      width: 900,
      height: 1200,
      deviceScaleFactor: 1,
    });

    await page.setContent(html, {
      waitUntil: "domcontentloaded",
    });

    await page.evaluateHandle("document.fonts.ready");

    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      preferCSSPageSize: false,
      margin: {
        top: "10mm",
        right: "10mm",
        bottom: "10mm",
        left: "10mm",
      },
    });

    return new Response(Buffer.from(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="Invoice-INV-${invoice.id}.pdf"`,
        "Cache-Control": "no-store",
      },
    });
  } finally {
    await browser.close();
  }
}