import { Form, useLoaderData } from "react-router";
import { useState } from "react";
import {
  AppProvider,
  Page,
  Layout,
  Card,
  Text,
  IndexTable,
  BlockStack,
  InlineStack,
  Select,
  Button,
} from "@shopify/polaris";
import "@shopify/polaris/build/esm/styles.css";

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

  const staff = await prisma.staff.findMany({
    orderBy: { name: "asc" },
  });

  const startDate = getStartDate(period);

  const sales = await prisma.sale.findMany({
    where: {
      ...(staffId !== "all" ? { staffId: Number(staffId) } : {}),
      ...(startDate ? { createdAt: { gte: startDate } } : {}),
    },
    orderBy: { createdAt: "desc" },
    include: {
      staff: true,
      lineItems: true,
    },
  });

  const totalSales = sales.reduce((sum, sale) => sum + sale.total, 0);
  const totalVat = sales.reduce((sum, sale) => sum + sale.vatAmount, 0);
  const totalDiscount = sales.reduce((sum, sale) => sum + sale.discountTotal, 0);
  const averageSale = sales.length ? totalSales / sales.length : 0;

  const paymentTotals: Record<string, { count: number; total: number }> = {};

  for (const sale of sales) {
    const method = sale.paymentMethod || "Unknown";

    if (!paymentTotals[method]) {
      paymentTotals[method] = { count: 0, total: 0 };
    }

    paymentTotals[method].count += 1;
    paymentTotals[method].total += sale.total;
  }

  return {
    staff,
    selectedStaffId: staffId,
    selectedPeriod: period,
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
    sales,
    summary,
    paymentTotals,
  } = useLoaderData<typeof loader>();

  const [staffId, setStaffId] = useState(selectedStaffId);
  const [period, setPeriod] = useState(selectedPeriod);

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
    { label: "All time", value: "all" },
  ];

  return (
    <AppProvider i18n={{}}>
      <Page title="Sales Reports">
        <Layout>
          <Layout.Section>
            <Card>
              <Form method="get">
                <InlineStack gap="300" blockAlign="end">
                  <div style={{ minWidth: 240 }}>
                    <Select
                      label="Employee"
                      name="staffId"
                      options={staffOptions}
                      value={staffId}
                      onChange={setStaffId}
                    />
                  </div>

                  <div style={{ minWidth: 240 }}>
                    <Select
                      label="Report period"
                      name="period"
                      options={periodOptions}
                      value={period}
                      onChange={setPeriod}
                    />
                  </div>

                  <Button submit variant="primary">
                    Run Report
                  </Button>
                </InlineStack>
              </Form>
            </Card>
          </Layout.Section>

          <Layout.Section>
            <InlineStack gap="300">
              <div style={{ flex: 1 }}>
                <Card>
                  <BlockStack gap="200">
                    <Text as="p" tone="subdued">Sales Count</Text>
                    <Text as="h2" variant="headingLg">{summary.count}</Text>
                  </BlockStack>
                </Card>
              </div>

              <div style={{ flex: 1 }}>
                <Card>
                  <BlockStack gap="200">
                    <Text as="p" tone="subdued">Total Sales</Text>
                    <Text as="h2" variant="headingLg">
                      £{summary.totalSales.toFixed(2)}
                    </Text>
                  </BlockStack>
                </Card>
              </div>

              <div style={{ flex: 1 }}>
                <Card>
                  <BlockStack gap="200">
                    <Text as="p" tone="subdued">Average Sale</Text>
                    <Text as="h2" variant="headingLg">
                      £{summary.averageSale.toFixed(2)}
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
                    <Text as="p" tone="subdued">VAT Total</Text>
                    <Text as="h2" variant="headingMd">
                      £{summary.totalVat.toFixed(2)}
                    </Text>
                  </BlockStack>
                </Card>
              </div>

              <div style={{ flex: 1 }}>
                <Card>
                  <BlockStack gap="200">
                    <Text as="p" tone="subdued">Discount Total</Text>
                    <Text as="h2" variant="headingMd">
                      £{summary.totalDiscount.toFixed(2)}
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
                resourceName={{ singular: "payment method", plural: "payment methods" }}
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
                    <IndexTable.Cell>£{data.total.toFixed(2)}</IndexTable.Cell>
                  </IndexTable.Row>
                ))}
              </IndexTable>
            </Card>
          </Layout.Section>

          <Layout.Section>
            <Card>
              <Text as="h2" variant="headingMd">
                Sales log
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
                    <IndexTable.Cell>£{sale.total.toFixed(2)}</IndexTable.Cell>
                    <IndexTable.Cell>
                      {new Date(sale.createdAt).toLocaleString()}
                    </IndexTable.Cell>
                  </IndexTable.Row>
                ))}
              </IndexTable>
            </Card>
          </Layout.Section>
        </Layout>
      </Page>
    </AppProvider>
  );
}