import prisma from "../db.server";
import puppeteer from "puppeteer-core";
import { Buffer } from "node:buffer";

function money(value: any) {
  return `£${Number(value ?? 0).toFixed(2)}`;
}

function safe(value: any) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export async function generateInvoicePdf(invoiceId: number) {
  const invoice = await prisma.sale.findUnique({
    where: { id: invoiceId },
    select: {
      id: true,
      customerName: true,
      customerEmail: true,
      customerPhone: true,
      customerVatNumber: true,
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
      paymentMethod: true,
      paymentStatus: true,
      amountPaid: true,
      balanceDue: true,
      vatAmount: true,
      total: true,
      subtotal: true,
      discountTotal: true,
      createdAt: true,
      staff: { select: { name: true } },
      lineItems: {
        select: {
          title: true,
          sku: true,
          quantity: true,
          unitPrice: true,
          discount: true,
          lineTotal: true,
        },
      },
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
      font-size: 11px;
    }

    .page {
      padding: 18px 28px;
      width: 100%;
    }

    .header {
      display: flex;
      justify-content: space-between;
      gap: 20px;
      background: white;
      border-bottom: 3px solid #111827;
      padding-bottom: 14px;
      margin-bottom: 14px;
    }

    .invoice-title {
      font-size: 28px;
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
      font-size: 11px;
      line-height: 1.35;
      min-width: 220px;
    }

    .business h2 {
      font-size: 12px;
      margin: 4px 0 4px;
    }

    .business p {
      margin: 2px 0;
    }

    .logo {
      max-width: 150px;
      max-height: 60px;
      object-fit: contain;
      margin-bottom: 5px;
    }

    .meta-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      border: 1px solid #dfe3e8;
      border-radius: 8px;
      overflow: hidden;
      margin-bottom: 12px;
    }

    .meta-cell {
      padding: 10px 12px;
      border-right: 1px solid #dfe3e8;
      min-height: 56px;
    }

    .meta-cell:last-child {
      border-right: none;
    }

    .label {
      font-size: 10px;
      color: #4b5870;
      text-transform: uppercase;
      letter-spacing: 0.8px;
      margin-bottom: 5px;
    }

    .value {
      font-weight: 700;
      line-height: 1.3;
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
      gap: 12px;
      margin-bottom: 12px;
    }

    .address-box {
      border: 1px solid #dfe3e8;
      border-radius: 8px;
      padding: 10px 14px;
      min-height: 80px;
    }

    .address-title {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 1.1px;
      margin-bottom: 7px;
      color: #111827;
    }

    p {
      margin: 3px 0;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 8px;
    }

    th {
      background: #111827;
      color: white;
      text-align: left;
      padding: 7px 9px;
      font-size: 10px;
      font-weight: 700;
    }

    td {
      padding: 6px 9px;
      border-bottom: 1px solid #e5e7eb;
      font-size: 11px;
      vertical-align: top;
    }

    .right {
      text-align: right;
    }

    .totals {
      width: 340px;
      margin-left: auto;
      margin-top: 14px;
      border: 1px solid #dfe3e8;
      border-radius: 8px;
      overflow: hidden;
    }

    .totals-row {
      display: flex;
      justify-content: space-between;
      padding: 7px 13px;
      border-bottom: 1px solid #e5e7eb;
      font-size: 11px;
    }

    .totals-row:last-child {
      border-bottom: none;
    }

    .total-row {
      background: #111827;
      color: white;
      font-weight: 700;
      font-size: 14px;
    }

    .balance-row {
      background: #ffecec;
      color: #b00020;
      font-weight: 700;
    }

    .footer {
      margin-top: 18px;
      font-size: 10px;
      color: #555;
      border-top: 1px solid #ddd;
      padding-top: 8px;
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
        <div class="address-title">Invoice Address</div>
        <p><strong>${safe(invoice.customerName)}</strong></p>
        <p>${safe(invoice.customerEmail || "")}</p>
        <p>${safe(invoice.customerPhone || "")}</p>
        ${invoice.customerVatNumber ? `<p>VAT Number: ${safe(invoice.customerVatNumber)}</p>` : ""}
        <p>${safe(invoice.address1 || "")}</p>
        <p>${safe(invoice.address2 || "")}</p>
        <p>${[invoice.city, invoice.county].filter(Boolean).map(safe).join(", ")}</p>
        <p>${safe(invoice.postcode || "")}</p>
        <p>${safe(invoice.country || "")}</p>
      </div>

      <div class="address-box">
        <div class="address-title">Delivery Address</div>
        ${(invoice.deliveryAddress1 || invoice.deliveryCity || invoice.deliveryPostcode)
          ? `<p>${safe(invoice.deliveryAddress1 || "")}</p>
             <p>${safe(invoice.deliveryAddress2 || "")}</p>
             <p>${[invoice.deliveryCity, invoice.deliveryCounty].filter(Boolean).map(safe).join(", ")}</p>
             <p>${safe(invoice.deliveryPostcode || "")}</p>
             <p>${safe(invoice.deliveryCountry || "")}</p>`
          : `<p style="color:#888;font-style:italic;">Same as invoice address</p>`}
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
        <span>Invoice Discount</span>
        <span>-${money((invoice as any).invoiceDiscountAmount || 0)}</span>
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

    <div class="footer">
      ${balanceDue > 0 ? `
      <p style="margin:0 0 6px; font-weight:700; text-transform:uppercase; letter-spacing:0.5px;">Payment Information</p>
      <p style="margin:0 0 4px;">INVOICES CAN BE PAID VIA BANK TRANSFER OR BY CALLING 02870348834 TO PAY OVER THE PHONE.</p>
      <p style="margin:0 0 4px;">First time orders will need paid via bank transfer.</p>
      <p style="margin:0 0 4px;">Registered in Northern Ireland &nbsp;|&nbsp; VAT Registration Number XI369865135</p>
      <p style="margin:0 0 4px;">Danske Bank</p>
      <p style="margin:0 0 4px;">Name On Account : Nii Clean Ltd</p>
      <p style="margin:0 0 4px;">Sort Code : 95 06 79</p>
      <p style="margin:0 0 4px;">Account Number : 40254274</p>
      <p style="margin:0 0 4px;">IBAN : GB83 DABA 9506 7940 2542 74</p>
      <p style="margin:0;">BIC/SWIFT : DABAGB2B</p>
      ` : `<p style="margin:0;">Thank you for your business. &nbsp;|&nbsp; Registered in Northern Ireland &nbsp;|&nbsp; VAT No: XI369865135</p>`}
    </div>
  </div>
</body>
</html>`;

  const browser = await puppeteer.launch({
    headless: true,
    executablePath:
      process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium-browser",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--single-process",
      "--no-zygote",
    ],
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
      scale: 0.88,
      margin: {
        top: "8mm",
        right: "8mm",
        bottom: "8mm",
        left: "8mm",
      },
    });

    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}