import { useLoaderData, useNavigate } from "react-router";
import {
  AppProvider,
  Page,
  Layout,
  Card,
  Text,
  Button,
  IndexTable,
  InlineStack,
} from "@shopify/polaris";
import "@shopify/polaris/build/esm/styles.css";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export async function loader({ request }: { request: Request }) {
  await authenticate.admin(request);

  const quotes = await prisma.quote.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      staff: true,
      lineItems: true,
    },
  });

  return { quotes };
}

export default function QuotesPage() {
  const { quotes } = useLoaderData<typeof loader>();
  const navigate = useNavigate();

  return (
    <AppProvider i18n={{}}>
      <Page title="Quotes">
        <Layout>
          <Layout.Section>
            <Card>
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h2" variant="headingMd">
                  Saved quotes
                </Text>

                <Button variant="primary" onClick={() => navigate("/app/quote")}>
                  Create Quote
                </Button>
              </InlineStack>
            </Card>
          </Layout.Section>

          <Layout.Section>
            <Card>
              <IndexTable
                resourceName={{ singular: "quote", plural: "quotes" }}
                itemCount={quotes.length}
                headings={[
                  { title: "Quote" },
                  { title: "Customer" },
                  { title: "Salesperson" },
                  { title: "Total" },
                  { title: "Date" },
                  { title: "Actions" },
                ]}
                selectable={false}
              >
                {quotes.map((quote: any, index: number) => (
                  <IndexTable.Row id={String(quote.id)} key={quote.id} position={index}>
                    <IndexTable.Cell>
                      <Text as="span" fontWeight="bold">
                        QUO-{quote.id}
                      </Text>
                    </IndexTable.Cell>

                    <IndexTable.Cell>{quote.customerName}</IndexTable.Cell>
                    <IndexTable.Cell>{quote.staff?.name || "-"}</IndexTable.Cell>
                    <IndexTable.Cell>£{quote.total.toFixed(2)}</IndexTable.Cell>
                    <IndexTable.Cell>
                      {new Date(quote.createdAt).toLocaleString()}
                    </IndexTable.Cell>

                    <IndexTable.Cell>
                      <InlineStack gap="200">
                        <Button onClick={() => navigate(`/app/quotes/${quote.id}`)}>
                          View
                        </Button>

                        <Button onClick={() => navigate(`/app/quotes/${quote.id}/print`)}>
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