import { authenticate } from "../shopify.server";
import { generateInvoicePdf } from "../utils/invoice-pdf.server";

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { invoiceId: string };
}) {
  await authenticate.admin(request);

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