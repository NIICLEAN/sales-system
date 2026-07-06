import { generateQuotePdf } from "../utils/quote-pdf.server";

export async function loader({
  params,
}: {
  request: Request;
  params: { quoteId: string };
}) {
  const quoteId = Number(params.quoteId);
  const pdf = await generateQuotePdf(quoteId);

  return new Response(pdf, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="Quote-QUO-${quoteId}.pdf"`,
      "Cache-Control": "no-store",
    },
  });
}