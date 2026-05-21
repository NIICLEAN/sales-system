import { authenticate } from "../shopify.server";
import { generateQuotePdf } from "../utils/quote-pdf.server";

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { quoteId: string };
}) {
  await authenticate.admin(request);

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