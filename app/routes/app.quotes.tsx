import { useLoaderData, useLocation, useNavigate } from "react-router";
import {
  AppProvider,
  Page,
  Layout,
  Card,
  Banner,
  Text,
  Button,
  IndexTable,
  InlineStack,
} from "@shopify/polaris";
import "@shopify/polaris/build/esm/styles.css";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export async function loader({ request }: { request: Request }) {
  try {
    await authenticate.admin(request);

    const rawQuotes = await prisma.quote.findMany({
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        customerName: true,
        total: true,
        createdAt: true,
        staffId: true,
      },
    });

    const staffIds = Array.from(new Set(rawQuotes.map((quote) => quote.staffId)));
    const staffRecords = staffIds.length
      ? await prisma.staff.findMany({
          where: { id: { in: staffIds } },
          select: { id: true, name: true },
        })
      : [];

    const staffById = new Map(staffRecords.map((staff) => [staff.id, staff.name]));

    const quotes = rawQuotes.map((quote) => ({
      ...quote,
      staff: staffById.has(quote.staffId)
        ? { name: staffById.get(quote.staffId) }
        : null,
    }));

    return { quotes, error: null };
  } catch (error) {
    console.error("Failed to load quotes:", error);
    return { quotes: [], error: "Quotes could not be loaded right now." };
  }
}

export default function QuotesPage() {
  const { quotes, error } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const location = useLocation();

  function withEmbeddedParams(path: string) {
    const [pathname, queryString = ""] = path.split("?");
    const currentParams = new URLSearchParams(location.search);
    const nextParams = new URLSearchParams(queryString);

    for (const key of ["shop", "host", "embedded", "id_token"]) {
      const value = currentParams.get(key);
      if (value && !nextParams.has(key)) {
        nextParams.set(key, value);
      }
    }

    const nextQuery = nextParams.toString();
    return nextQuery ? `${pathname}?${nextQuery}` : pathname;
  }

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

                <Button variant="primary" onClick={() => navigate(withEmbeddedParams("/app/quote"))}>
                  Create Quote
                </Button>
              </InlineStack>
            </Card>
          </Layout.Section>

          <Layout.Section>
            {error ? <Banner tone="critical">{error}</Banner> : null}

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
                    <IndexTable.Cell>£{Number(quote.total ?? 0).toFixed(2)}</IndexTable.Cell>
                    <IndexTable.Cell>
                      {new Date(quote.createdAt).toLocaleString()}
                    </IndexTable.Cell>

                    <IndexTable.Cell>
                      <InlineStack gap="200">
                        <Button onClick={() => navigate(withEmbeddedParams(`/app/quotes/${quote.id}`))}>
                          View
                        </Button>

                        <Button onClick={() => navigate(withEmbeddedParams(`/app/quotes/${quote.id}/print`))}>
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