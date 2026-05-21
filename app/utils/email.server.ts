import nodemailer from "nodemailer";

const transporter = nodemailer.createTransport({
  host: process.env.OUTLOOK_SMTP_HOST,
  port: Number(process.env.OUTLOOK_SMTP_PORT),
  secure: false,
  auth: {
    user: process.env.OUTLOOK_EMAIL,
    pass: process.env.OUTLOOK_PASSWORD,
  },
});

export async function sendTestEmail() {
  const result = await transporter.sendMail({
    from: `"NII Clean Products" <${process.env.OUTLOOK_EMAIL}>`,
    to: "office@niiclean.com",
    subject: "Invoice email test",
    html: `
      <h2>Email Working ✅</h2>
      <p>Your Outlook SMTP is connected.</p>
    `,
  });

  console.log(result);
}