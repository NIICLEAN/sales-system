import { authenticate } from "../shopify.server";
import prisma from "../db.server";

function getStartDate(period: string) {
  const now = new Date();
  const start = new Date(now);

  if (period === "today") {
    start.setHours(0, 0, 0, 0);
    return start;
  }

  if (period === "week") {
    start.setDate(now.getDate() - now.getDay());
    start.setHours(0, 0, 0, 0);
    return start;
  }

  if (period === "month") {
    return new Date(now.getFullYear(), now.getMonth(), 1);
  }

  if (period === "sixMonths") {
    start.setMonth(now.getMonth() - 6);
    start.setHours(0, 0, 0, 0);
    return start;
  }

  if (period === "year") {
    return new Date(now.getFullYear(), 0, 1);
  }

  return null;
}

function csvEscape(value: any) {
  const stringValue = value === null || value === undefined ? "" : String(value);
  return `"${stringValue.replace(/"/g, '""')}"`;
}

export async function loader({ request }: { request: Request }) {
  await authenticate.admin(request);

  const url = new URL(request.url);
  const staffId = url.searchParams.get("staffId") || "all";
  const period = url.searchParams.get("period") || "today";
  const fromDate = url.searchParams.get("fromDate") || "";
  const toDate = url.searchParams.get("toDate") || "";

  let dateFilter: any = {};

  if (period === "custom" && fromDate) {
    dateFilter.gte = new Date(`${fromDate}T00:00:00`);
  } else {
    const startDate = getStartDate(period);

    if (startDate) {
      dateFilter.gte = startDate;
    }
  }

  if (period === "custom" && toDate) {
    dateFilter.lte = new Date(`${toDate}T23:59:59`);
  }

  const sales = await prisma.sale.findMany({
    where: {
      ...(staffId !== "all" ? { staffId: Number(staffId) } : {}),
      ...(Object.keys(dateFilter).length ? { createdAt: dateFilter } : {}),
    },
    orderBy: { createdAt: "desc" },
    include: {
      staff: true,
    },
  });

  const rows = [
    [
      "Invoice",
      "Shopify Order Number",
      "Customer",
      "Customer Email",
      "Payment Method",
      "Payment Reference",
      "Salesperson",
      "Subtotal",
      "Discount",
      "VAT",
      "Total Amount",
      "Date/Time",
    ],
    ...sales.map((sale) => [
      `INV-${sale.id}`,
      sale.shopifyOrderName || "",
      sale.customerName || "",
      sale.customerEmail || "",
      sale.paymentMethod || "",
      sale.reference || "",
      sale.staff?.name || "",
      Number(sale.subtotal).toFixed(2),
      Number(sale.discountTotal).toFixed(2),
      Number(sale.vatAmount).toFixed(2),
      Number(sale.total).toFixed(2),
      new Date(sale.createdAt).toLocaleString("en-GB"),
    ]),
  ];

  const csv = rows.map((row) => row.map(csvEscape).join(",")).join("\n");

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="sales-report-${new Date()
        .toISOString()
        .slice(0, 10)}.csv"`,
    },
  });
}