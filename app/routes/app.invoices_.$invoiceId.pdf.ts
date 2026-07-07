import { generateInvoicePdf } from "../utils/invoice-pdf.server";

export async function loader({
  params,
}: {
  request: Request;
  params: { invoiceId: string };
}) {
  const invoiceId = Number(params.invoiceId);
  try {
    const pdf = await generateInvoicePdf(invoiceId);
    return new Response(pdf, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="Invoice-INV-${invoiceId}.pdf"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error: any) {
    console.error("Invoice PDF generation failed:", error);
    return new Response(
      JSON.stringify({ error: String(error?.message || "PDF generation failed") }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
}