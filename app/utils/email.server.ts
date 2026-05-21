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
}: {
  to: string;
  customerName: string;
  invoiceId: number;
  pdfBuffer: Buffer;
}) {
  if (!to) return;

  await transporter.sendMail({
    from: `"NII Clean Products" <${process.env.OUTLOOK_EMAIL}>`,
    to,
    subject: `Invoice INV-${invoiceId}`,
    html: `
      <p>Hi ${customerName || "there"},</p>
      <p>Thank you for your order.</p>
      <p>Your invoice is attached.</p>
      <p>Kind regards,<br/>NII Clean Products</p>
    `,
    attachments: [
      {
        filename: `Invoice-INV-${invoiceId}.pdf`,
        content: pdfBuffer,
      },
    ],
  });
}