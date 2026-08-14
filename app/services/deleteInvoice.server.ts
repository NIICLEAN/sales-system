import prisma from "../db.server";

function isMissingPaymentTableError(error: any) {
  const message = String(error?.message || "");
  return (
    message.includes("The table `public.Payment` does not exist") ||
    (message.toLowerCase().includes("table") &&
      message.includes("Payment") &&
      message.toLowerCase().includes("does not exist"))
  );
}

export async function deleteInvoiceWithRelations(invoiceId: number) {
  // Payment table may be absent on legacy databases.
  try {
    await prisma.payment.deleteMany({ where: { saleId: invoiceId } });
  } catch (error) {
    if (!isMissingPaymentTableError(error)) {
      throw error;
    }
  }

  await prisma.saleLineItem.deleteMany({ where: { saleId: invoiceId } });

  // SaleShippingMeta is managed via raw SQL table; ignore if table is unavailable.
  try {
    await prisma.$executeRawUnsafe(
      'DELETE FROM "SaleShippingMeta" WHERE "saleId" = $1',
      invoiceId,
    );
  } catch {
    // Ignore and continue deleting invoice.
  }

  await prisma.sale.delete({ where: { id: invoiceId } });
}
