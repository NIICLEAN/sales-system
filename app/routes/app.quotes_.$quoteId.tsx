import { useLoaderData, useNavigate } from "react-router";
import {
  AppProvider,
  Page,
  Layout,
  Card,
  Text,
  Button,
  BlockStack,
  InlineStack,
  IndexTable,
} from "@shopify/polaris";
import "@shopify/polaris/build/esm/styles.css";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { quoteId: string };
}) {
  await authenticate.admin(request);

  const quote = await prisma.quote.findUnique({
    where: { id: Number(params.quoteId) },
    include: {
      staff: true,
      lineItems: true,
    },
  });

  if (!quote) {
    throw new Response("Quote not found", { status: 404 });
  }

  return { quote };
}

export default function QuoteViewPage() {
  const { quote } = useLoaderData<typeof loader>();
  const navigate = useNavigate();

  return (
    <AppProvider i18n={{}}>
      <Page
        title={`Quote QUO-${quote.id}`}
        backAction={{ content: "Quotes", onAction: () => navigate("/app/quotes") }}
      >
        <Layout>
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">Customer</Text>
                <Text as="p">{quote.customerName}</Text>
                <Text as="p">{quote.customerEmail || "-"}</Text>
                <Text as="p">{quote.customerPhone || "-"}</Text>

                <Text as="h2" variant="headingMd">Address</Text>
                <Text as="p">{quote.address1 || "-"}</Text>
                <Text as="p">{quote.address2 || ""}</Text>
                <Text as="p">{quote.city || ""} {quote.county || ""}</Text>
                <Text as="p">{quote.postcode || ""}</Text>
                <Text as="p">{quote.country || ""}</Text>

                <Text as="h2" variant="headingMd">Details</Text>
                <Text as="p">Salesperson: {quote.staff?.name || "-"}</Text>
                <Text as="p">Reference: {quote.reference || "-"}</Text>
                <Text as="p">Created: {new Date(quote.createdAt).toLocaleString()}</Text>

                <InlineStack gap="200">
                  <Button
                    variant="primary"
                    onClick={() => navigate(`/app/quotes/${quote.id}/print`)}
                  >
                    Print Quote
                  </Button>

                  <Button onClick={() => navigate("/app/quotes")}>
                    Back
                  </Button>
                </InlineStack>
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section>
            <Card>
              <Text as="h2" variant="headingMd">Items</Text>

              <IndexTable
                resourceName={{ singular: "item", plural: "items" }}
                itemCount={quote.lineItems.length}
                headings={[
                  { title: "Item" },
                  { title: "SKU" },
                  { title: "Qty" },
                  { title: "Unit" },
                  { title: "Discount" },
                  { title: "Line total" },
                ]}
                selectable={false}
              >
                {quote.lineItems.map((item: any, index: number) => (
                  <IndexTable.Row key={item.id} id={String(item.id)} position={index}>
                    <IndexTable.Cell>{item.title}</IndexTable.Cell>
                    <IndexTable.Cell>{item.sku || "-"}</IndexTable.Cell>
                    <IndexTable.Cell>{item.quantity}</IndexTable.Cell>
                    <IndexTable.Cell>£{item.unitPrice.toFixed(2)}</IndexTable.Cell>
                    <IndexTable.Cell>£{item.discount.toFixed(2)}</IndexTable.Cell>
                    <IndexTable.Cell>£{item.lineTotal.toFixed(2)}</IndexTable.Cell>
                  </IndexTable.Row>
                ))}
              </IndexTable>

              <div style={{ marginTop: 20 }}>
                <Text as="p">Subtotal: £{quote.subtotal.toFixed(2)}</Text>
                <Text as="p">Discount: £{quote.discountTotal.toFixed(2)}</Text>
                <Text as="p">VAT: £{quote.vatAmount.toFixed(2)}</Text>
                <Text as="p" fontWeight="bold">Total: £{quote.total.toFixed(2)}</Text>
              </div>
            </Card>
          </Layout.Section>
        </Layout>
      </Page>
    </AppProvider>
  );
}