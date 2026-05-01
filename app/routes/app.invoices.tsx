import { useLoaderData, useNavigate } from "react-router";
import {
  AppProvider,
  Page,
  Layout,
  Card,
  IndexTable,
  Text,
  Button,
  InlineStack,
} from "@shopify/polaris";
import "@shopify/polaris/build/esm/styles.css";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export async function loader({ request }: { request: Request }) {
  await authenticate.admin(request);

  const invoices = await prisma.sale.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      staff: true,
      lineItems: true,
    },
  });

  return { invoices };
}

export default function InvoicesPage() {
  const { invoices } = useLoaderData<typeof loader>();
  const navigate = useNavigate();

  return (
    <AppProvider i18n={{}}>
      <Page title="Invoices">
        <Layout>
          <Layout.Section>
            <Card>
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h2" variant="headingMd">
                  Saved invoices
                </Text>

                <Button
                  variant="primary"
                  onClick={() => navigate("/app/invoice")}
                >
                  Create Invoice
                </Button>
              </InlineStack>
            </Card>
          </Layout.Section>

          <Layout.Section>
            <Card>
              <IndexTable
                resourceName={{ singular: "invoice", plural: "invoices" }}
                itemCount={invoices.length}
                headings={[
                  { title: "Invoice" },
                  { title: "Customer" },
                  { title: "Salesperson" },
                  { title: "Payment" },
                  { title: "Total" },
                  { title: "Date" },
                  { title: "Actions" },
                ]}
                selectable={false}
              >
                {invoices.map((invoice: any, index: number) => (
                  <IndexTable.Row
                    id={String(invoice.id)}
                    key={invoice.id}
                    position={index}
                  >
                    <IndexTable.Cell>
                      <Text as="span" fontWeight="bold">
                        INV-{invoice.id}
                      </Text>
                    </IndexTable.Cell>

                    <IndexTable.Cell>{invoice.customerName}</IndexTable.Cell>

                    <IndexTable.Cell>
                      {invoice.staff?.name || "-"}
                    </IndexTable.Cell>

                    <IndexTable.Cell>{invoice.paymentMethod}</IndexTable.Cell>

                    <IndexTable.Cell>
                      £{invoice.total.toFixed(2)}
                    </IndexTable.Cell>

                    <IndexTable.Cell>
                      {new Date(invoice.createdAt).toLocaleString()}
                    </IndexTable.Cell>

                    <IndexTable.Cell>
                      <InlineStack gap="200">
                        <Button onClick={() => navigate(`/app/invoices/${invoice.id}`)}>
                            View
                        </Button>

                      <Button onClick={() => { navigate(`/app/invoices/${invoice.id}/print`); }}>
                         Print
                        </Button>
                      </InlineStack>
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