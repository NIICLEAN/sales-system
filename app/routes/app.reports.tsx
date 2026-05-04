import { Form, useLoaderData } from "react-router";
import { useState } from "react";
import {
  Page,
  Layout,
  Card,
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

  const sales = await prisma.sale.findMany({
    where: {
      ...(staffId !== "all" ? { staffId: Number(staffId) } : {}),
      ...(Object.keys(dateFilter).length ? { createdAt: dateFilter } : {}),
    },
    orderBy: { createdAt: "desc" },
    include: {
      staff: true,
      lineItems: true,
    },
  });

  const totalSales = sales.reduce((sum, sale) => sum + Number(sale.total), 0);
  const totalVat = sales.reduce((sum, sale) => sum + Number(sale.vatAmount), 0);
  const totalDiscount = sales.reduce(
    (sum, sale) => sum + Number(sale.discountTotal),
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
    paymentTotals[method].total += Number(sale.total);
  }

  return {
    staff,
    selectedStaffId: staffId,
    selectedPeriod: period,
    selectedFromDate: fromDate,
    selectedToDate: toDate,
    sales,
    summary: {
      count: sales.length,
      totalSales,
      totalVat,
      totalDiscount,
      averageSale,
    },
    paymentTotals: Object.entries(paymentTotals),
  };
}

export default function ReportsPage() {
  const {
    staff,
    selectedStaffId,
    selectedPeriod,
    selectedFromDate,
    selectedToDate,
    sales,
    summary,
    paymentTotals,
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

  const downloadParams = new URLSearchParams({
    staffId,
    period,
    fromDate,
    toDate,
  });

  const downloadUrl = `/app/reports/download?${downloadParams.toString()}`;

  return (
    <Page title="Sales Reports">
      <Layout>
        <Layout.Section>
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

                  <a
                    href={downloadUrl}
                    target="_blank"
                    rel="noreferrer"
                    style={{ textDecoration: "none" }}
                  >
                    <Button>Download CSV</Button>
                  </a>
                </InlineStack>
              </BlockStack>
            </Form>
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
                    £{Number(summary.totalSales).toFixed(2)}
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
                    £{Number(summary.averageSale).toFixed(2)}
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
                    £{Number(summary.totalVat).toFixed(2)}
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
                    £{Number(summary.totalDiscount).toFixed(2)}
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
                    £{Number(data.total).toFixed(2)}
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
                  <IndexTable.Cell>{sale.shopifyOrderName || "-"}</IndexTable.Cell>
                  <IndexTable.Cell>{sale.reference || "-"}</IndexTable.Cell>
                  <IndexTable.Cell>{sale.staff?.name || "-"}</IndexTable.Cell>
                  <IndexTable.Cell>£{Number(sale.total).toFixed(2)}</IndexTable.Cell>
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
                  <IndexTable.Cell>{sale.shopifyOrderName || "-"}</IndexTable.Cell>
                  <IndexTable.Cell>{sale.customerName}</IndexTable.Cell>
                  <IndexTable.Cell>{sale.staff?.name || "-"}</IndexTable.Cell>
                  <IndexTable.Cell>{sale.paymentMethod}</IndexTable.Cell>
                  <IndexTable.Cell>{sale.reference || "-"}</IndexTable.Cell>
                  <IndexTable.Cell>£{Number(sale.total).toFixed(2)}</IndexTable.Cell>
                  <IndexTable.Cell>
                    {new Date(sale.createdAt).toLocaleString("en-GB")}
                  </IndexTable.Cell>
                </IndexTable.Row>
              ))}
            </IndexTable>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}