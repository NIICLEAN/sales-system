import { useEffect } from "react";
import { useLoaderData, useNavigate, useSearchParams } from "react-router";
import {
  Page,
  Layout,
  Card,
  Text,
  Button,
  BlockStack,
  InlineStack,
  IndexTable,
  Badge,
  Divider,
} from "@shopify/polaris";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";

function money(value: any) {
  return `£${Number(value || 0).toFixed(2)}`;
}

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

  return {
    quote,
    logoUrl: process.env.BUSINESS_LOGO_URL || "",
  };
}

export default function QuoteViewPage() {
  const { quote } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  useEffect(() => {
    if (searchParams.get("autoprint") !== "1") return;

    const timer = window.setTimeout(() => {
      navigate(`/app/quotes/${quote.id}/print?autoprint=1`);
    }, 400);

    return () => window.clearTimeout(timer);
  }, [searchParams, navigate, quote.id]);

  return (
    <Page
      title={`Quote QUO-${quote.id}`}
      subtitle="Review, print, or download this customer quote."
      backAction={{
        content: "Quotes",
        onAction: () => navigate("/app/quotes"),
      }}
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="400">
                <InlineStack align="space-between" blockAlign="center">
                  <BlockStack gap="100">
                    <Text as="h2" variant="headingLg">
                      QUO-{quote.id}
                    </Text>
                    <Text as="p" tone="subdued">
                      Created {new Date(quote.createdAt).toLocaleString("en-GB")}
                    </Text>
                  </BlockStack>

                  <Badge tone="info">Quote</Badge>
                </InlineStack>

                <Divider />

                <InlineStack gap="300">
                  <Button
                    variant="primary"
                    onClick={() => navigate(`/app/quotes/${quote.id}/print`)}
                  >
                    Print / Download Quote
                  </Button>

                  <Button onClick={() => navigate("/app/quotes")}>Back</Button>
                </InlineStack>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Customer details
                </Text>

                <InlineStack gap="400" align="start">
                  <div style={{ flex: 1 }}>
                    <Text as="p" fontWeight="bold">
                      Customer
                    </Text>
                    <Text as="p">{quote.customerName}</Text>
                    <Text as="p">{quote.customerEmail || "-"}</Text>
                    <Text as="p">{quote.customerPhone || "-"}</Text>
                  </div>

                  <div style={{ flex: 1 }}>
                    <Text as="p" fontWeight="bold">
                      Address
                    </Text>
                    <Text as="p">{quote.address1 || "-"}</Text>
                    <Text as="p">{quote.address2 || ""}</Text>
                    <Text as="p">
                      {quote.city || ""} {quote.county || ""}
                    </Text>
                    <Text as="p">{quote.postcode || ""}</Text>
                    <Text as="p">{quote.country || ""}</Text>
                  </div>
                </InlineStack>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Quote details
                </Text>

                <InlineStack gap="400">
                  <div style={{ flex: 1 }}>
                    <Text as="p" fontWeight="bold">
                      Salesperson
                    </Text>
                    <Text as="p">{quote.staff?.name || "-"}</Text>
                  </div>

                  <div style={{ flex: 1 }}>
                    <Text as="p" fontWeight="bold">
                      Reference
                    </Text>
                    <Text as="p">{quote.reference || "-"}</Text>
                  </div>
                </InlineStack>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Quote lines
                </Text>

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
                    <IndexTable.Row
                      key={item.id}
                      id={String(item.id)}
                      position={index}
                    >
                      <IndexTable.Cell>{item.title}</IndexTable.Cell>
                      <IndexTable.Cell>{item.sku || "-"}</IndexTable.Cell>
                      <IndexTable.Cell>{item.quantity}</IndexTable.Cell>
                      <IndexTable.Cell>{money(item.unitPrice)}</IndexTable.Cell>
                      <IndexTable.Cell>{money(item.discount)}</IndexTable.Cell>
                      <IndexTable.Cell>{money(item.lineTotal)}</IndexTable.Cell>
                    </IndexTable.Row>
                  ))}
                </IndexTable>
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>

        <Layout.Section variant="oneThird">
          <div style={{ position: "sticky", top: 16 }}>
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Summary
                </Text>

                <InlineStack align="space-between">
                  <Text as="p">Subtotal</Text>
                  <Text as="p">{money(quote.subtotal)}</Text>
                </InlineStack>

                <InlineStack align="space-between">
                  <Text as="p">Discount</Text>
                  <Text as="p">{money(quote.discountTotal)}</Text>
                </InlineStack>

                <InlineStack align="space-between">
                  <Text as="p">VAT</Text>
                  <Text as="p">{money(quote.vatAmount)}</Text>
                </InlineStack>

                <Divider />

                <InlineStack align="space-between">
                  <Text as="p" fontWeight="bold">
                    Total
                  </Text>
                  <Text as="p" fontWeight="bold">
                    {money(quote.total)}
                  </Text>
                </InlineStack>

                <Button
                  variant="primary"
                  fullWidth
                  onClick={() => navigate(`/app/quotes/${quote.id}/print`)}
                >
                  Print / Download Quote
                </Button>
              </BlockStack>
            </Card>
          </div>
        </Layout.Section>
      </Layout>
    </Page>
  );
}