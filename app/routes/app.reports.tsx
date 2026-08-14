import { Form, useLoaderData } from "react-router";
import { useState } from "react";
import {
  Page,
  Layout,
  Card,
  Banner,
  Text,
  IndexTable,
  BlockStack,
  InlineStack,
  Select,
  Button,
  TextField,
} from "@shopify/polaris";

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

export async function loader({ request }: { request: Request }) {
  try {
    await authenticate.admin(request);

    const url = new URL(request.url);
    const staffId = url.searchParams.get("staffId") || "all";
    const period = url.searchParams.get("period") || "today";
    const fromDate = url.searchParams.get("fromDate") || "";
    const toDate = url.searchParams.get("toDate") || "";

    const staff = await prisma.staff.findMany({
      orderBy: { name: "asc" },
    });

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

    const rawSales = await prisma.sale.findMany({
      where: {
        ...(staffId !== "all" ? { staffId: Number(staffId) } : {}),
        ...(Object.keys(dateFilter).length ? { createdAt: dateFilter } : {}),
      },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        shopifyOrderName: true,
        customerName: true,
        customerEmail: true,
        paymentMethod: true,
        reference: true,
        subtotal: true,
        discountTotal: true,
        vatAmount: true,
        total: true,
        createdAt: true,
        staffId: true,
      },
    });

    const staffIds = Array.from(new Set(rawSales.map((sale) => sale.staffId)));
    const staffRecords = staffIds.length
      ? await prisma.staff.findMany({
          where: { id: { in: staffIds } },
          select: { id: true, name: true },
        })
      : [];

    const staffById = new Map(staffRecords.map((person) => [person.id, person.name]));

    const sales = rawSales.map((sale) => ({
      ...sale,
      staff: staffById.has(sale.staffId)
        ? { name: staffById.get(sale.staffId) }
        : null,
    }));

    const totalSales = sales.reduce((sum, sale) => sum + Number(sale.total ?? 0), 0);
    const totalVat = sales.reduce((sum, sale) => sum + Number(sale.vatAmount ?? 0), 0);
    const totalDiscount = sales.reduce(
      (sum, sale) => sum + Number(sale.discountTotal ?? 0),
      0,
    );
    const averageSale = sales.length ? totalSales / sales.length : 0;

    const paymentTotals: Record<string, { count: number; total: number }> = {};

    for (const sale of sales) {
      const method = sale.paymentMethod || "Unknown";

      if (!paymentTotals[method]) {
        paymentTotals[method] = { count: 0, total: 0 };
      }

      paymentTotals[method].count += 1;
      paymentTotals[method].total += Number(sale.total ?? 0);
    }

    // Load individual payment records for the accurate per-method EOD breakdown
    type PaymentRecord = {
      id: number;
      amount: number;
      method: string;
      provider: string | null;
      reference: string | null;
      createdAt: Date;
      saleId: number;
      shopifyOrderName: string | null;
      customerName: string | null;
    };
    let payments: PaymentRecord[] = [];
    try {
      const rawPayments = await prisma.payment.findMany({
        where: {
          ...(Object.keys(dateFilter).length ? { createdAt: dateFilter } : {}),
        },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          amount: true,
          method: true,
          provider: true,
          reference: true,
          createdAt: true,
          sale: {
            select: { id: true, shopifyOrderName: true, customerName: true },
          },
        },
      });
      payments = rawPayments.map((p) => ({
        id: p.id,
        amount: Number(p.amount),
        method: String(p.method),
        provider: p.provider ?? null,
        reference: p.reference ?? null,
        createdAt: p.createdAt,
        saleId: p.sale.id,
        shopifyOrderName: p.sale.shopifyOrderName,
        customerName: p.sale.customerName,
      }));
    } catch (err) {
      console.error("Failed to load payment records for EOD:", err);
    }

    const eodTotals: Record<string, { count: number; total: number }> = {};
    for (const p of payments) {
      const label = p.provider || p.method;
      if (!eodTotals[label]) eodTotals[label] = { count: 0, total: 0 };
      eodTotals[label].count += 1;
      eodTotals[label].total += p.amount;
    }
    const grandTotalTakings = payments.reduce((s, p) => s + p.amount, 0);

    return {
      staff,
      selectedStaffId: staffId,
      selectedPeriod: period,
      selectedFromDate: fromDate,
      selectedToDate: toDate,
      sales,
      payments,
      eodTotals: Object.entries(eodTotals),
      grandTotalTakings,
      summary: {
        count: sales.length,
        totalSales,
        totalVat,
        totalDiscount,
        averageSale,
      },
      paymentTotals: Object.entries(paymentTotals),
      error: null,
    };
  } catch (error) {
    console.error("Failed to load reports:", error);
    return {
      staff: [],
      selectedStaffId: "all",
      selectedPeriod: "today",
      selectedFromDate: "",
      selectedToDate: "",
      sales: [],
      summary: {
        count: 0,
        totalSales: 0,
        totalVat: 0,
        totalDiscount: 0,
        averageSale: 0,
      },
      paymentTotals: [],
      payments: [],
      eodTotals: [],
      grandTotalTakings: 0,
      error: "Reports could not be loaded right now.",
    };
  }
}

export default function ReportsPage() {
  const {
    staff,
    selectedStaffId,
    selectedPeriod,
    selectedFromDate,
    selectedToDate,
    sales,
    payments,
    eodTotals,
    grandTotalTakings,
    summary,
    paymentTotals,
    error,
  } = useLoaderData<typeof loader>();

  const [staffId, setStaffId] = useState(selectedStaffId);
  const [period, setPeriod] = useState(selectedPeriod);
  const [fromDate, setFromDate] = useState(selectedFromDate);
  const [toDate, setToDate] = useState(selectedToDate);

  const staffOptions = [
    { label: "All employees", value: "all" },
    ...staff.map((person: any) => ({
      label: person.name,
      value: String(person.id),
    })),
  ];

  const periodOptions = [
    { label: "Today", value: "today" },
    { label: "This week", value: "week" },
    { label: "This month", value: "month" },
    { label: "Last 6 months", value: "sixMonths" },
    { label: "This year", value: "year" },
    { label: "Custom date range", value: "custom" },
    { label: "All time", value: "all" },
  ];

  function csvEscape(value: any) {
    const stringValue =
      value === null || value === undefined ? "" : String(value);

    return `"${stringValue.replace(/"/g, '""')}"`;
  }

  function formatCurrency(value: any) {
    return `£${Number(value ?? 0).toFixed(2)}`;
  }

  function downloadCsv() {
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
      ...sales.map((sale: any) => [
        `INV-${sale.id}`,
        sale.shopifyOrderName || "",
        sale.customerName || "",
        sale.customerEmail || "",
        sale.paymentMethod || "",
        sale.reference || "",
        sale.staff?.name || "",
        Number(sale.subtotal ?? 0).toFixed(2),
        Number(sale.discountTotal ?? 0).toFixed(2),
        Number(sale.vatAmount ?? 0).toFixed(2),
        Number(sale.total ?? 0).toFixed(2),
        new Date(sale.createdAt).toLocaleString("en-GB"),
      ]),
    ];

    const csv = rows.map((row) => row.map(csvEscape).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);

    const link = document.createElement("a");
    link.href = url;
    link.download = `sales-report-${new Date().toISOString().slice(0, 10)}.csv`;

    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    URL.revokeObjectURL(url);
  }

  return (
    <Page title="Sales Reports">
      <Layout>
        <Layout.Section>
          {error ? <Banner tone="critical">{error}</Banner> : null}

          <Card>
            <Form method="get">
              <BlockStack gap="400">
                <InlineStack gap="300" blockAlign="end">
                  <div style={{ minWidth: 220 }}>
                    <Select
                      label="Employee"
                      name="staffId"
                      options={staffOptions}
                      value={staffId}
                      onChange={setStaffId}
                    />
                  </div>

                  <div style={{ minWidth: 220 }}>
                    <Select
                      label="Report period"
                      name="period"
                      options={periodOptions}
                      value={period}
                      onChange={setPeriod}
                    />
                  </div>

                  {period === "custom" && (
                    <>
                      <div style={{ minWidth: 180 }}>
                        <TextField
                          label="From date"
                          name="fromDate"
                          type="date"
                          value={fromDate}
                          onChange={setFromDate}
                          autoComplete="off"
                        />
                      </div>

                      <div style={{ minWidth: 180 }}>
                        <TextField
                          label="To date"
                          name="toDate"
                          type="date"
                          value={toDate}
                          onChange={setToDate}
                          autoComplete="off"
                        />
                      </div>
                    </>
                  )}

                  <Button submit variant="primary">
                    Run Report
                  </Button>

                  <Button onClick={downloadCsv}>Download CSV</Button>

                  <Button onClick={() => window.print()}>Print Daily Report</Button>
                </InlineStack>
              </BlockStack>
            </Form>
          </Card>
        </Layout.Section>

        {/* ── Daily Takings ──────────────────────────────────── */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h2" variant="headingLg">Daily Takings</Text>
                <Text as="p" tone="subdued">
                  {payments.length} payment{payments.length !== 1 ? "s" : ""} recorded
                </Text>
              </InlineStack>

              {payments.length === 0 ? (
                <Text as="p" tone="subdued">No payments recorded for this period.</Text>
              ) : (
                <>
                  <div className="eod-totals-grid">
                    {(eodTotals as any[]).map(([method, data]) => (
                      <div key={method} className="eod-method-card">
                        <div className="eod-method-label">{method}</div>
                        <div className="eod-method-amount">{formatCurrency(data.total)}</div>
                        <div className="eod-method-count">{data.count} payment{data.count !== 1 ? "s" : ""}</div>
                      </div>
                    ))}
                    <div className="eod-method-card eod-total-card">
                      <div className="eod-method-label">Grand Total</div>
                      <div className="eod-method-amount">{formatCurrency(grandTotalTakings)}</div>
                      <div className="eod-method-count">{payments.length} total</div>
                    </div>
                  </div>

                  <IndexTable
                    resourceName={{ singular: "payment", plural: "payments" }}
                    itemCount={payments.length}
                    headings={[
                      { title: "Time" },
                      { title: "Invoice / Order" },
                      { title: "Customer" },
                      { title: "Method" },
                      { title: "Reference" },
                      { title: "Amount" },
                    ]}
                    selectable={false}
                  >
                    {(payments as any[]).map((p, index) => (
                      <IndexTable.Row id={String(p.id)} key={p.id} position={index}>
                        <IndexTable.Cell>
                          {new Date(p.createdAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
                        </IndexTable.Cell>
                        <IndexTable.Cell>{p.shopifyOrderName || `INV-${p.saleId}`}</IndexTable.Cell>
                        <IndexTable.Cell>{p.customerName || "-"}</IndexTable.Cell>
                        <IndexTable.Cell><span style={{ fontWeight: 600 }}>{p.provider || p.method}</span></IndexTable.Cell>
                        <IndexTable.Cell>{p.reference || "-"}</IndexTable.Cell>
                        <IndexTable.Cell><span style={{ fontWeight: 700 }}>{formatCurrency(p.amount)}</span></IndexTable.Cell>
                      </IndexTable.Row>
                    ))}
                  </IndexTable>
                </>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">Staff Performance</Text>
              <Text as="p" tone="subdued">
                {selectedPeriod === "today" ? "Today" : selectedPeriod === "week" ? "This week" : selectedPeriod === "month" ? "This month" : selectedPeriod === "year" ? "This year" : "Selected period"}
              </Text>
              {sales.length === 0 ? (
                <Text as="p" tone="subdued">No sales in this period.</Text>
              ) : (
                <div>
                  {(() => {
                    const byStaff: Record<string, { name: string; count: number; total: number; vat: number }> = {};
                    for (const sale of sales as any[]) {
                      const name = sale.staff?.name || "Unknown";
                      if (!byStaff[name]) byStaff[name] = { name, count: 0, total: 0, vat: 0 };
                      byStaff[name].count += 1;
                      byStaff[name].total += Number(sale.total ?? 0);
                      byStaff[name].vat += Number(sale.vatAmount ?? 0);
                    }
                    const rows = Object.values(byStaff).sort((a, b) => b.total - a.total);
                    return (
                      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                        <div style={{ display: "flex", gap: 12, padding: "6px 8px", fontWeight: 600, fontSize: 12, color: "#6d7175", textTransform: "uppercase", borderBottom: "1px solid #e1e3e5" }}>
                          <span style={{ flex: 2 }}>Staff Member</span>
                          <span style={{ minWidth: 70, textAlign: "center" }}>Invoices</span>
                          <span style={{ minWidth: 90, textAlign: "right" }}>VAT</span>
                          <span style={{ minWidth: 100, textAlign: "right" }}>Revenue</span>
                        </div>
                        {rows.map((row) => (
                          <div key={row.name} style={{ display: "flex", gap: 12, padding: "8px 8px", alignItems: "center", borderBottom: "1px solid #f1f2f3" }}>
                            <span style={{ flex: 2, fontWeight: 500 }}>{row.name}</span>
                            <span style={{ minWidth: 70, textAlign: "center", color: "#6d7175" }}>{row.count}</span>
                            <span style={{ minWidth: 90, textAlign: "right", color: "#6d7175" }}>{formatCurrency(row.vat)}</span>
                            <span style={{ minWidth: 100, textAlign: "right", fontWeight: 700 }}>{formatCurrency(row.total)}</span>
                          </div>
                        ))}
                        <div style={{ display: "flex", gap: 12, padding: "8px 8px", alignItems: "center", fontWeight: 700, background: "#f6f6f7", borderRadius: 4, marginTop: 4 }}>
                          <span style={{ flex: 2 }}>Total</span>
                          <span style={{ minWidth: 70, textAlign: "center" }}>{(sales as any[]).length}</span>
                          <span style={{ minWidth: 90, textAlign: "right" }}>{formatCurrency(summary.totalVat)}</span>
                          <span style={{ minWidth: 100, textAlign: "right" }}>{formatCurrency(summary.totalSales)}</span>
                        </div>
                      </div>
                    );
                  })()}
                </div>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <InlineStack gap="300">
            <div style={{ flex: 1 }}>
              <Card>
                <BlockStack gap="200">
                  <Text as="p" tone="subdued">
                    Sales Count
                  </Text>
                  <Text as="h2" variant="headingLg">
                    {summary.count}
                  </Text>
                </BlockStack>
              </Card>
            </div>

            <div style={{ flex: 1 }}>
              <Card>
                <BlockStack gap="200">
                  <Text as="p" tone="subdued">
                    Total Sales
                  </Text>
                  <Text as="h2" variant="headingLg">
                    {formatCurrency(summary.totalSales)}
                  </Text>
                </BlockStack>
              </Card>
            </div>

            <div style={{ flex: 1 }}>
              <Card>
                <BlockStack gap="200">
                  <Text as="p" tone="subdued">
                    Average Sale
                  </Text>
                  <Text as="h2" variant="headingLg">
                    {formatCurrency(summary.averageSale)}
                  </Text>
                </BlockStack>
              </Card>
            </div>
          </InlineStack>
        </Layout.Section>

        <Layout.Section>
          <InlineStack gap="300">
            <div style={{ flex: 1 }}>
              <Card>
                <BlockStack gap="200">
                  <Text as="p" tone="subdued">
                    VAT Total
                  </Text>
                  <Text as="h2" variant="headingMd">
                    {formatCurrency(summary.totalVat)}
                  </Text>
                </BlockStack>
              </Card>
            </div>

            <div style={{ flex: 1 }}>
              <Card>
                <BlockStack gap="200">
                  <Text as="p" tone="subdued">
                    Discount Total
                  </Text>
                  <Text as="h2" variant="headingMd">
                    {formatCurrency(summary.totalDiscount)}
                  </Text>
                </BlockStack>
              </Card>
            </div>
          </InlineStack>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <Text as="h2" variant="headingMd">
              Payment method breakdown
            </Text>

            <IndexTable
              resourceName={{
                singular: "payment method",
                plural: "payment methods",
              }}
              itemCount={paymentTotals.length}
              headings={[
                { title: "Payment method" },
                { title: "Sales count" },
                { title: "Total" },
              ]}
              selectable={false}
            >
              {paymentTotals.map(([method, data]: any, index: number) => (
                <IndexTable.Row id={method} key={method} position={index}>
                  <IndexTable.Cell>{method}</IndexTable.Cell>
                  <IndexTable.Cell>{data.count}</IndexTable.Cell>
                  <IndexTable.Cell>
                    {formatCurrency(data.total)}
                  </IndexTable.Cell>
                </IndexTable.Row>
              ))}
            </IndexTable>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <Text as="h2" variant="headingMd">
              Sales report download preview
            </Text>

            <IndexTable
              resourceName={{ singular: "sale", plural: "sales" }}
              itemCount={sales.length}
              headings={[
                { title: "Invoice" },
                { title: "Order Number" },
                { title: "Payment Reference" },
                { title: "Salesperson" },
                { title: "Amount" },
                { title: "Date / Time" },
              ]}
              selectable={false}
            >
              {sales.map((sale: any, index: number) => (
                <IndexTable.Row id={String(sale.id)} key={sale.id} position={index}>
                  <IndexTable.Cell>INV-{sale.id}</IndexTable.Cell>
                  <IndexTable.Cell>
                    {sale.shopifyOrderName || "-"}
                  </IndexTable.Cell>
                  <IndexTable.Cell>{sale.reference || "-"}</IndexTable.Cell>
                  <IndexTable.Cell>{sale.staff?.name || "-"}</IndexTable.Cell>
                  <IndexTable.Cell>
                    {formatCurrency(sale.total)}
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    {new Date(sale.createdAt).toLocaleString("en-GB")}
                  </IndexTable.Cell>
                </IndexTable.Row>
              ))}
            </IndexTable>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <Text as="h2" variant="headingMd">
              Full sales log
            </Text>

            <IndexTable
              resourceName={{ singular: "sale", plural: "sales" }}
              itemCount={sales.length}
              headings={[
                { title: "Invoice" },
                { title: "Shopify Order" },
                { title: "Customer" },
                { title: "Employee" },
                { title: "Payment" },
                { title: "Reference" },
                { title: "Total" },
                { title: "Date" },
              ]}
              selectable={false}
            >
              {sales.map((sale: any, index: number) => (
                <IndexTable.Row id={String(sale.id)} key={sale.id} position={index}>
                  <IndexTable.Cell>INV-{sale.id}</IndexTable.Cell>
                  <IndexTable.Cell>
                    {sale.shopifyOrderName || "-"}
                  </IndexTable.Cell>
                  <IndexTable.Cell>{sale.customerName}</IndexTable.Cell>
                  <IndexTable.Cell>{sale.staff?.name || "-"}</IndexTable.Cell>
                  <IndexTable.Cell>{sale.paymentMethod}</IndexTable.Cell>
                  <IndexTable.Cell>{sale.reference || "-"}</IndexTable.Cell>
                  <IndexTable.Cell>
                    {formatCurrency(sale.total)}
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    {new Date(sale.createdAt).toLocaleString("en-GB")}
                  </IndexTable.Cell>
                </IndexTable.Row>
              ))}
            </IndexTable>
          </Card>
        </Layout.Section>
      </Layout>

      {/* ── Print: End of Day Report ───────────────────────── */}
      <div className="eod-print-only">
        <div className="eod-print-header">
          <div>
            <div className="eod-print-title">End of Day Report</div>
            <div className="eod-print-sub">NII Clean Products</div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div className="eod-print-sub">
              {selectedPeriod === "today"
                ? new Date().toLocaleDateString("en-GB", { weekday: "long", day: "2-digit", month: "long", year: "numeric" })
                : selectedPeriod === "custom"
                ? `${selectedFromDate} to ${selectedToDate}`
                : selectedPeriod}
            </div>
            <div className="eod-print-sub">Printed: {new Date().toLocaleString("en-GB")}</div>
          </div>
        </div>

        <div className="eod-print-totals">
          {(eodTotals as any[]).map(([method, data]) => (
            <div key={method} className="eod-print-method">
              <span className="eod-print-method-name">{method}</span>
              <span className="eod-print-method-count">{data.count} payment{data.count !== 1 ? "s" : ""}</span>
              <span className="eod-print-method-total">{formatCurrency(data.total)}</span>
            </div>
          ))}
          <div className="eod-print-method eod-print-grand">
            <span className="eod-print-method-name">GRAND TOTAL</span>
            <span className="eod-print-method-count">{payments.length} payment{payments.length !== 1 ? "s" : ""}</span>
            <span className="eod-print-method-total">{formatCurrency(grandTotalTakings)}</span>
          </div>
        </div>

        <table className="eod-print-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Invoice</th>
              <th>Customer</th>
              <th>Method</th>
              <th>Reference</th>
              <th style={{ textAlign: "right" }}>Amount</th>
            </tr>
          </thead>
          <tbody>
            {(payments as any[]).map((p) => (
              <tr key={p.id}>
                <td>{new Date(p.createdAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</td>
                <td>{p.shopifyOrderName || `INV-${p.saleId}`}</td>
                <td>{p.customerName || "-"}</td>
                <td><strong>{p.provider || p.method}</strong></td>
                <td>{p.reference || "-"}</td>
                <td style={{ textAlign: "right", fontWeight: 700 }}>{formatCurrency(p.amount)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="eod-print-table-total">
              <td colSpan={5}>Total</td>
              <td style={{ textAlign: "right" }}>{formatCurrency(grandTotalTakings)}</td>
            </tr>
          </tfoot>
        </table>

        <div className="eod-print-sig">
          <div className="eod-print-sig-line">Checked by: ________________________</div>
          <div className="eod-print-sig-line">Date: ________________________</div>
        </div>
      </div>

      <style>{`
        .eod-totals-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
          gap: 12px;
        }
        .eod-method-card {
          background: #f6f6f7;
          border-radius: 12px;
          padding: 14px 18px;
        }
        .eod-total-card {
          background: #202223;
          color: #fff;
        }
        .eod-method-label { font-size: 13px; font-weight: 600; color: #6d7175; margin-bottom: 4px; }
        .eod-total-card .eod-method-label { color: #aaa; }
        .eod-method-amount { font-size: 22px; font-weight: 800; color: #202223; }
        .eod-total-card .eod-method-amount { color: #fff; }
        .eod-method-count { font-size: 12px; color: #6d7175; margin-top: 2px; }
        .eod-total-card .eod-method-count { color: #aaa; }
        .eod-print-only { display: none; }

        @media print {
          @page { size: A4 portrait; margin: 12mm; }
          body * { visibility: hidden; }
          .eod-print-only, .eod-print-only * { visibility: visible; }
          .eod-print-only {
            display: block !important;
            position: absolute;
            inset: 0;
            background: white;
            font-family: Arial, sans-serif;
            color: #111;
            padding: 0;
          }
          .eod-print-header {
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
            border-bottom: 3px solid #111;
            padding-bottom: 10px;
            margin-bottom: 16px;
          }
          .eod-print-title { font-size: 26px; font-weight: 900; }
          .eod-print-sub { font-size: 13px; margin-top: 4px; color: #444; }
          .eod-print-totals {
            display: flex;
            flex-direction: column;
            gap: 0;
            margin-bottom: 20px;
            border: 2px solid #222;
            border-radius: 8px;
            overflow: hidden;
          }
          .eod-print-method {
            display: flex;
            align-items: center;
            padding: 10px 16px;
            border-bottom: 1px solid #ddd;
            font-size: 14px;
          }
          .eod-print-method:last-child { border-bottom: none; }
          .eod-print-grand {
            background: #111;
            color: #fff;
            font-size: 16px;
            font-weight: 800;
          }
          .eod-print-method-name { flex: 1; font-weight: 700; }
          .eod-print-method-count { width: 120px; color: #666; font-size: 12px; }
          .eod-print-grand .eod-print-method-count { color: #bbb; }
          .eod-print-method-total { width: 100px; text-align: right; font-weight: 800; font-size: 16px; }
          .eod-print-table {
            width: 100%;
            border-collapse: collapse;
            font-size: 12px;
            margin-bottom: 24px;
          }
          .eod-print-table th {
            background: #f0f0f0;
            border-bottom: 2px solid #999;
            padding: 7px 10px;
            text-align: left;
            font-size: 11px;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 0.04em;
          }
          .eod-print-table td {
            padding: 7px 10px;
            border-bottom: 1px solid #e0e0e0;
          }
          .eod-print-table-total td {
            border-top: 2px solid #222;
            border-bottom: none;
            font-weight: 800;
            font-size: 14px;
            padding-top: 10px;
          }
          .eod-print-sig {
            display: flex;
            gap: 60px;
            margin-top: 32px;
            padding-top: 20px;
            border-top: 1px solid #bbb;
          }
          .eod-print-sig-line { font-size: 13px; color: #555; }
        }
      `}</style>
    </Page>
  );
}