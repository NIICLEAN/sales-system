import nodemailer from "nodemailer";

const transporter = nodemailer.createTransport({
  host: process.env.OUTLOOK_SMTP_HOST,
  port: Number(process.env.OUTLOOK_SMTP_PORT || 587),
  secure: false,
  auth: {
    user: process.env.OUTLOOK_EMAIL,
    pass: process.env.OUTLOOK_PASSWORD,
  },
});

export async function sendInvoiceEmail({
  to,
  customerName,
  invoiceId,
  pdfBuffer,
  paymentStatus,
}: {
  to: string;
  customerName: string;
  invoiceId: number;
  pdfBuffer: Buffer;
  paymentStatus: string;
}) {
  if (!to) return;

  const logoUrl = process.env.BUSINESS_LOGO_URL || "";

  await transporter.sendMail({
    from: `"NII Clean Products" <${process.env.OUTLOOK_EMAIL}>`,
    to,
    subject: `Invoice INV-${invoiceId}`,
html: `
<div style="font-family: Arial, sans-serif; background:#f5f7fa; padding:40px 20px;">
  <div style="max-width:700px; margin:0 auto; background:#ffffff; border-radius:14px; overflow:hidden; border:1px solid #e5e7eb;">

<div style="background:#111827; padding:30px; text-align:center;">

  ${
    logoUrl
      ? `
      <img
        src="${logoUrl}"
        alt="NII Clean Products"
        style="
          max-width:220px;
          max-height:90px;
          object-fit:contain;
          margin-bottom:18px;
        "
      />
    `
      : ""
  }

  <p style="margin:0; color:#d1d5db; font-size:14px;">
    Invoice INV-${invoiceId}
  </p>
</div>

    <div style="padding:35px;">
      <p style="font-size:16px; color:#111;">
        Hi ${customerName || "there"},
      </p>

      <p style="font-size:15px; color:#444; line-height:1.7;">
        Thank you for your order with 
        <strong>NII Clean Products</strong>.
      </p>

      <p style="font-size:15px; color:#444; line-height:1.7;">
        Please find your invoice attached as a PDF for your records.
      </p>

      ${
        paymentStatus !== "Paid"
          ? `
      <div style="margin:30px 0; background:#fff8e7; border:1px solid #f4d27c; border-radius:12px; padding:22px;">
        <h3 style="margin:0 0 12px; color:#8a5a00;">
          Payment Information
        </h3>

        <p style="margin:0 0 16px; color:#444; line-height:1.7;">
          Invoices can be paid via bank transfer or by calling
          <strong>02870348834</strong> to pay over the phone.
        </p>

        <table style="width:100%; font-size:14px; border-collapse:collapse;">
          <tr>
            <td style="padding:6px 0;"><strong>Bank</strong></td>
            <td>Danske Bank</td>
          </tr>

          <tr>
            <td style="padding:6px 0;"><strong>Account Name</strong></td>
            <td>NII Clean Ltd</td>
          </tr>

          <tr>
            <td style="padding:6px 0;"><strong>Sort Code</strong></td>
            <td>95-06-79</td>
          </tr>

          <tr>
            <td style="padding:6px 0;"><strong>Account Number</strong></td>
            <td>40254274</td>
          </tr>

          <tr>
            <td style="padding:6px 0;"><strong>IBAN</strong></td>
            <td>GB83 DABA 9506 7940 2542 74</td>
          </tr>

          <tr>
            <td style="padding:6px 0;"><strong>BIC / SWIFT</strong></td>
            <td>DABAGB2B</td>
          </tr>
        </table>
      </div>
      `
          : `
      <div style="margin:30px 0; background:#ecfdf5; border:1px solid #a7f3d0; border-radius:12px; padding:22px;">
        <h3 style="margin:0; color:#047857;">
          Payment Received
        </h3>

        <p style="margin:12px 0 0; color:#444;">
          Thank you — your invoice has been marked as paid.
        </p>
      </div>
      `
      }

      <p style="font-size:15px; color:#444; line-height:1.7;">
        If you have any questions regarding your order or invoice,
        please reply to this email or call us.
      </p>

      <p style="margin-top:30px; color:#111;">
        Kind regards,<br />
        <strong>NII Clean Products</strong>
      </p>
    </div>

    <div style="background:#f9fafb; border-top:1px solid #e5e7eb; padding:24px; font-size:12px; color:#6b7280;">
      Registered in Northern Ireland<br />
      VAT Registration Number XI369865135
    </div>
  </div>
</div>
`,
    attachments: [
      {
        filename: `Invoice-INV-${invoiceId}.pdf`,
        content: pdfBuffer,
      },
    ],
  });
}

export async function sendQuoteEmail({
  to,
  customerName,
  quoteId,
  pdfBuffer,
}: {
  to: string;
  customerName: string;
  quoteId: number;
  pdfBuffer: Buffer;
}) {
  if (!to) return;

  const logoUrl = process.env.BUSINESS_LOGO_URL || "";

  await transporter.sendMail({
    from: `"NII Clean Products" <${process.env.OUTLOOK_EMAIL}>`,
    to,
    subject: `Quote QUO-${quoteId}`,
    html: `
      <div style="font-family: Arial, sans-serif; background:#f5f7fa; padding:40px 20px;">
        <div style="max-width:700px; margin:0 auto; background:white; border-radius:14px; overflow:hidden; border:1px solid #e5e7eb;">
          <div style="background:#111827; padding:30px; text-align:center;">
            ${
              logoUrl
                ? `<img src="${logoUrl}" alt="NII Clean Products" style="max-width:220px; max-height:90px; object-fit:contain; margin-bottom:18px;" />`
                : ""
            }

            <p style="margin:0; color:#d1d5db; font-size:14px;">
              Quote QUO-${quoteId}
            </p>
          </div>

          <div style="padding:35px;">
            <p style="font-size:16px; color:#111;">
              Hi ${customerName || "there"},
            </p>

            <p style="font-size:15px; color:#444; line-height:1.7;">
              Thank you for your enquiry with <strong>NII Clean Products</strong>.
            </p>

            <p style="font-size:15px; color:#444; line-height:1.7;">
              Please find your quote attached as a PDF.
            </p>

            <p style="font-size:15px; color:#444; line-height:1.7;">
              This quote is subject to stock availability.
            </p>

            <p style="margin-top:30px; color:#111;">
              Kind regards,<br />
              <strong>NII Clean Products</strong>
            </p>
          </div>

          <div style="background:#f9fafb; border-top:1px solid #e5e7eb; padding:24px; font-size:12px; color:#6b7280;">
            Registered in Northern Ireland<br />
            VAT Registration Number XI369865135
          </div>
        </div>
      </div>
    `,
    attachments: [
      {
        filename: `Quote-QUO-${quoteId}.pdf`,
        content: pdfBuffer,
      },
    ],
  });
}