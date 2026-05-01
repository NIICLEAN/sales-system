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
  params: { invoiceId: string };
}) {
  await authenticate.admin(request);

  const invoice = await prisma.sale.findUnique({
    where: { id: Number(params.invoiceId) },
    include: {
      staff: true,
      lineItems: true,
    },
  });

  if (!invoice) {
    throw new Response("Invoice not found", { status: 404 });
  }

  return { invoice };
}

export default function InvoiceViewPage() {
  const { invoice } = useLoaderData<typeof loader>();
  const navigate = useNavigate();

  return (
    <AppProvider i18n={{}}>
      <Page
        title={`Invoice INV-${invoice.id}`}
        backAction={{ content: "Invoices", onAction: () => navigate("/app/invoices") }}
      >
        <Layout>
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Customer
                </Text>

                <Text as="p">{invoice.customerName}</Text>
                <Text as="p">{invoice.customerEmail || "-"}</Text>
                <Text as="p">{invoice.customerPhone || "-"}</Text>

                <Text as="h2" variant="headingMd">
                  Shipping address
                </Text>

                <Text as="p">{invoice.address1 || "-"}</Text>
                <Text as="p">{invoice.address2 || ""}</Text>
                <Text as="p">
                  {invoice.city || ""} {invoice.county || ""}
                </Text>
                <Text as="p">{invoice.postcode || ""}</Text>
                <Text as="p">{invoice.country || ""}</Text>

                <Text as="h2" variant="headingMd">
                  Details
                </Text>

                <Text as="p">Salesperson: {invoice.staff?.name || "-"}</Text>
                <Text as="p">Payment method: {invoice.paymentMethod}</Text>
                <Text as="p">Reference: {invoice.reference || "-"}</Text>
                <Text as="p">VAT number: {invoice.customerVatNumber || "-"}</Text>

                <Text as="p">
                  Created: {new Date(invoice.createdAt).toLocaleString()}
                </Text>

                <InlineStack gap="200">
                  <Button
                    variant="primary"
                    onClick={() =>
                      navigate(`/app/invoices/${invoice.id}/print`)
                    }
                  >
                    Print Invoice
                  </Button>

                  <Button onClick={() => navigate("/app/invoices")}>
                    Back
                  </Button>
                </InlineStack>
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section>
            <Card>
              <Text as="h2" variant="headingMd">
                Items
              </Text>

              <IndexTable
                resourceName={{ singular: "item", plural: "items" }}
                itemCount={invoice.lineItems.length}
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
                {invoice.lineItems.map((item: any, index: number) => (
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
                <Text as="p">Subtotal: £{invoice.subtotal.toFixed(2)}</Text>
                <Text as="p">Discount: £{invoice.discountTotal.toFixed(2)}</Text>
                <Text as="p">VAT: £{invoice.vatAmount.toFixed(2)}</Text>
                <Text as="p" fontWeight="bold">
                  Total: £{invoice.total.toFixed(2)}
                </Text>
              </div>
            </Card>
          </Layout.Section>
        </Layout>
      </Page>
    </AppProvider>
  );
}