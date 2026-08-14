import { Form, useLoaderData, useNavigation, useNavigate, useLocation } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import {
  Page,
  Layout,
  Card,
  Text,
  IndexTable,
  Badge,
  Button,
  BlockStack,
  InlineStack,
  Banner,
  Select,
} from "@shopify/polaris";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";

function formatCurrency(value: number) {
  return new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(value);
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "short",
    timeZone: "Europe/London",
  }).format(new Date(value));
}

function getDaysAgoDate(days: number) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin } = await authenticate.admin(request);

  const url = new URL(request.url);
  const days = Math.max(1, Math.min(365, Number(url.searchParams.get("days") || "30") || 30));

  const since = getDaysAgoDate(days);

  // Fetch recent Shopify orders
  let shopifyOrders: Array<{
    id: string;
    name: string;
    createdAt: string;
    customerName: string;
    customerEmail: string | null;
    total: number;
    financialStatus: string;
  }> = [];

  try {
    const query = `financial_status:paid created_at:>=${since.substring(0, 10)}`;
    let hasNextPage = true;
    let cursor: string | null = null;

    while (hasNextPage && shopifyOrders.length < 500) {
      const response = await admin.graphql(
        `
          query MissingOrdersCheck($query: String!, $cursor: String) {
            orders(first: 100, query: $query, sortKey: CREATED_AT, reverse: true, after: $cursor) {
              pageInfo {
                hasNextPage
                endCursor
              }
              edges {
                node {
                  id
                  name
                  createdAt
                  displayFinancialStatus
                  customer {
                    displayName
                    email
                  }
                  currentTotalPriceSet {
                    shopMoney {
                      amount
                    }
                  }
                }
              }
            }
          }
        `,
        { variables: { query, cursor } },
      );

      const json = (await response.json()) as any;
      const ordersData = json?.data?.orders;
      const edges = ordersData?.edges || [];

      for (const edge of edges) {
        const node = edge?.node;
        if (!node?.id) continue;
        shopifyOrders.push({
          id: String(node.id),
          name: String(node.name || ""),
          createdAt: String(node.createdAt || ""),
          customerName: String(node.customer?.displayName || "").trim() || "Unknown customer",
          customerEmail: String(node.customer?.email || "").trim() || null,
          total: Number(node.currentTotalPriceSet?.shopMoney?.amount ?? 0),
          financialStatus: String(node.displayFinancialStatus || ""),
        });
      }

      hasNextPage = Boolean(ordersData?.pageInfo?.hasNextPage);
      cursor = ordersData?.pageInfo?.endCursor || null;
      if (!hasNextPage) break;
    }
  } catch (error: any) {
    console.error("[missing-orders] Failed to fetch Shopify orders:", error);
    return {
      missingOrders: [],
      totalShopifyOrders: 0,
      days,
      error: String(error?.message || "Failed to fetch Shopify orders"),
    };
  }

  if (shopifyOrders.length === 0) {
    return { missingOrders: [], totalShopifyOrders: 0, days, error: null };
  }

  // Get all shopifyOrderIds and shopifyOrderNames in our DB for comparison
  const dbSales = await prisma.sale.findMany({
    select: { shopifyOrderId: true, shopifyOrderName: true },
    where: {
      OR: [
        { shopifyOrderId: { not: null } },
        { shopifyOrderName: { not: null } },
      ],
    },
  });

  const knownIds = new Set(dbSales.map((s) => String(s.shopifyOrderId || "").trim()).filter(Boolean));
  const knownNames = new Set(dbSales.map((s) => String(s.shopifyOrderName || "").trim().toLowerCase()).filter(Boolean));

  const missingOrders = shopifyOrders.filter((order) => {
    if (knownIds.has(order.id)) return false;
    if (order.name && knownNames.has(order.name.toLowerCase())) return false;
    return true;
  });

  return {
    missingOrders,
    totalShopifyOrders: shopifyOrders.length,
    days,
    error: null,
  };
}

export default function MissingOrdersPage() {
  const { missingOrders, totalShopifyOrders, days, error } = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const navigate = useNavigate();
  const location = useLocation();
  const isLoading = navigation.state === "loading";

  const daysOptions = [
    { label: "Last 7 days", value: "7" },
    { label: "Last 14 days", value: "14" },
    { label: "Last 30 days", value: "30" },
    { label: "Last 60 days", value: "60" },
    { label: "Last 90 days", value: "90" },
  ];

  function handleDaysChange(value: string) {
    const params = new URLSearchParams(location.search);
    params.set("days", value);
    navigate(`${location.pathname}?${params.toString()}`);
  }

  const rowMarkup = missingOrders.map((order, index) => (
    <IndexTable.Row id={order.id} key={order.id} position={index}>
      <IndexTable.Cell>
        <Text variant="bodyMd" fontWeight="semibold" as="span">
          {order.name}
        </Text>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <Text variant="bodyMd" as="span">
          {order.customerName}
        </Text>
        {order.customerEmail && (
          <Text variant="bodySm" tone="subdued" as="p">
            {order.customerEmail}
          </Text>
        )}
      </IndexTable.Cell>
      <IndexTable.Cell>
        <Text variant="bodyMd" as="span">
          {formatDate(order.createdAt)}
        </Text>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <Text variant="bodyMd" as="span">
          {formatCurrency(order.total)}
        </Text>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <Badge tone="success">{order.financialStatus}</Badge>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <Form method="post" action="/app/invoices">
          <input type="hidden" name="_intent" value="openShopifyLegacyInEditor" />
          <input type="hidden" name="shopifyOrderId" value={order.id} />
          <input type="hidden" name="openMode" value="edit" />
          <Button submit size="slim" variant="primary">
            Create Invoice
          </Button>
        </Form>
      </IndexTable.Cell>
    </IndexTable.Row>
  ));

  return (
    <Page
      title="Missing Orders"
      subtitle="Shopify paid orders that don't have an invoice in this app"
      backAction={{ content: "Invoices", url: "/app/invoices" }}
    >
      <Layout>
        <Layout.Section>
          {error && (
            <Banner tone="critical" title="Failed to load Shopify orders">
              <p>{error}</p>
            </Banner>
          )}

          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center">
                <BlockStack gap="100">
                  <Text variant="headingSm" as="h2">
                    {missingOrders.length === 0
                      ? `All ${totalShopifyOrders} Shopify paid orders are in the app`
                      : `${missingOrders.length} order${missingOrders.length === 1 ? "" : "s"} missing from ${totalShopifyOrders} Shopify paid orders`}
                  </Text>
                  {missingOrders.length > 0 && (
                    <Text variant="bodySm" tone="subdued" as="p">
                      These orders are marked Paid in Shopify but have no matching invoice in the app.
                      Click "Create Invoice" to import each one.
                    </Text>
                  )}
                </BlockStack>
                <Form method="get">
                  <Select
                    label="Period"
                    labelInline
                    options={daysOptions}
                    value={String(days)}
                    onChange={handleDaysChange}
                    name="days"
                  />
                </Form>
              </InlineStack>

              {missingOrders.length > 0 && (
                <IndexTable
                  resourceName={{ singular: "order", plural: "orders" }}
                  itemCount={missingOrders.length}
                  headings={[
                    { title: "Order" },
                    { title: "Customer" },
                    { title: "Date" },
                    { title: "Total" },
                    { title: "Status" },
                    { title: "Action" },
                  ]}
                  selectable={false}
                  loading={isLoading}
                >
                  {rowMarkup}
                </IndexTable>
              )}

              {missingOrders.length === 0 && !error && (
                <Text variant="bodyMd" tone="subdued" as="p">
                  No missing orders found in the last {days} days.
                </Text>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
