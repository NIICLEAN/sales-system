import { generateInvoicePdf } from "../utils/invoice-pdf.server";

export async function loader({
  params,
}: {
  request: Request;
  params: { invoiceId: string };
}) {
  const invoiceId = Number(params.invoiceId);
  const pdf = await generateInvoicePdf(invoiceId);

  return new Response(pdf, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="Invoice-INV-${invoiceId}.pdf"`,
      "Cache-Control": "no-store",
    },
  });
}