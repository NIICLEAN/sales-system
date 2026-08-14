import { generateQuotePdf } from "../utils/quote-pdf.server";

export async function loader({
  params,
}: {
  request: Request;
  params: { quoteId: string };
}) {
  const quoteId = Number(params.quoteId);
  try {
    const pdf = await generateQuotePdf(quoteId);
    return new Response(pdf, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="Quote-QUO-${quoteId}.pdf"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error: any) {
    console.error("Quote PDF generation failed:", error);
    return new Response(
      JSON.stringify({ error: String(error?.message || "PDF generation failed") }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
}