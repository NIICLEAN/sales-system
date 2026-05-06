import { Link, useLoaderData } from "react-router";
import {
  Page,
  Layout,
  Card,
  IndexTable,
  Text,
  Badge,
  Button,
  BlockStack,
} from "@shopify/polaris";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export async function loader({ request }: { request: Request }) {
  await authenticate.admin(request);

  const worksOrders = await prisma.worksOrder.findMany({
    where: {
      status: "awaiting_scheduled",
    },
    orderBy: {
      createdAt: "asc",
    },
    include: {
      lineItems: true,
    },
  });

return {
  worksOrders: worksOrders.map((order) => ({
    ...order,
    subtotal: Number(order.subtotal),
    discountTotal: Number(order.discountTotal),
    vatAmount: Number(order.vatAmount),
    total: Number(order.total),
    amountPaid: Number(order.amountPaid),
    lineItems: order.lineItems.map((item) => ({
      ...item,
      unitPrice: Number(item.unitPrice),
      discount: Number(item.discount),
      lineTotal: Number(item.lineTotal),
    })),
  })),
};}

function formatMoney(value: any) {
  return `£${Number(value || 0).toFixed(2)}`;
}

function formatDate(value: Date | string) {
  return new Date(value).toLocaleDateString("en-GB");
}

function paymentBadge(paymentStatus: string) {
  if (paymentStatus === "paid") {
    return <Badge tone="success">Paid</Badge>;
  }

  if (paymentStatus === "part_paid") {
    return <Badge tone="attention">Part paid</Badge>;
  }

  return <Badge tone="critical">Unpaid</Badge>;
}

export default function AwaitingScheduledPage() {
  const { worksOrders } = useLoaderData<typeof loader>();

  return (
    <Page
      title="Awaiting Scheduled"
      primaryAction={{
        content: "Create Works Order",
        url: "/app/works/new",
      }}
    >
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="p" tone="subdued">
                These jobs have been created but have not yet been assigned a
                date or engineer.
              </Text>

              <IndexTable
                resourceName={{
                  singular: "works order",
                  plural: "works orders",
                }}
                itemCount={worksOrders.length}
                headings={[
                  { title: "Created" },
                  { title: "Customer" },
                  { title: "Service" },
                  { title: "Total" },
                  { title: "Payment" },
                  { title: "Action" },
                ]}
                selectable={false}
              >
                {worksOrders.map((order: any, index: number) => (
                  <IndexTable.Row
                    id={String(order.id)}
                    key={order.id}
                    position={index}
                  >
                    <IndexTable.Cell>
                      {formatDate(order.createdAt)}
                    </IndexTable.Cell>

                    <IndexTable.Cell>
                      <Text as="span" fontWeight="bold">
                        {order.customerName}
                      </Text>
                    </IndexTable.Cell>

                    <IndexTable.Cell>{order.serviceType}</IndexTable.Cell>

                    <IndexTable.Cell>{formatMoney(order.total)}</IndexTable.Cell>

                    <IndexTable.Cell>
                      {paymentBadge(order.paymentStatus)}
                    </IndexTable.Cell>

                    <IndexTable.Cell>
                      <Link to={`/app/works/${order.id}`}>
                        <Button>View / Schedule</Button>
                      </Link>
                    </IndexTable.Cell>
                  </IndexTable.Row>
                ))}
              </IndexTable>

              {worksOrders.length === 0 && (
                <Text as="p" tone="subdued">
                  There are no works orders awaiting scheduling.
                </Text>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}