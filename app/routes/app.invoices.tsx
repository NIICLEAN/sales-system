import { Form, redirect, useLoaderData, useNavigate, useSearchParams } from "react-router";
import type { ActionFunctionArgs } from "react-router";
import {
  AppProvider,
  Page,
  Layout,
  Card,
  Banner,
  Select,
  IndexTable,
  Text,
  Button,
  InlineStack,
  BlockStack,
} from "@shopify/polaris";
import "@shopify/polaris/build/esm/styles.css";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getConnectedXeroClient, getXeroConnection } from "../services/xero.server";

function toNumber(value: unknown) {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function parseXeroDate(value: unknown) {
  if (!value) return new Date();
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return new Date();
  return date;
}

export async function action({ request }: ActionFunctionArgs) {
  await authenticate.admin(request);

  const formData = await request.formData();
  const intent = String(formData.get("_intent") || "");

  if (intent !== "syncXero") {
    return null;
  }

  try {
    const [defaultStaff, connection] = await Promise.all([
      prisma.staff.findFirst({ orderBy: { id: "asc" } }),
      getXeroConnection(),
    ]);

    if (!connection) {
      return redirect(
        "/app/invoices?syncStatus=error&syncMessage=Xero%20is%20not%20connected%20yet&connectXero=1",
      );
    }

    const { xero, tenantId } = await getConnectedXeroClient();

    if (!defaultStaff) {
      return redirect("/app/invoices?syncStatus=error&syncMessage=No%20staff%20record%20exists");
    }

    const response = await (xero.accountingApi as any).getInvoices(tenantId);
    const invoices = response?.body?.invoices ?? [];

    let importedCount = 0;

    for (const invoice of invoices) {
      const invoiceId = String(invoice?.invoiceID || "").trim();
      if (!invoiceId) continue;

      const reference = `XERO:${invoiceId}`;

      const existing = await prisma.sale.findFirst({
        where: {
          OR: [
            { reference },
            { shopifyOrderId: `xero:${invoiceId}` },
          ],
        },
        select: { id: true },
      });

      if (existing) continue;

      const total = toNumber(invoice?.total);
      const subtotal = toNumber(invoice?.subTotal);
      const vatAmount = toNumber(invoice?.totalTax);
      const amountPaid = toNumber(invoice?.amountPaid);
      const amountDue = toNumber(invoice?.amountDue);
      const balanceDue = amountDue || Math.max(total - amountPaid, 0);

      const paymentStatus =
        balanceDue <= 0 ? "Paid" : amountPaid > 0 ? "Partially Paid" : "Unpaid";

      await prisma.sale.create({
        data: {
          shopifyOrderId: `xero:${invoiceId}`,
          shopifyOrderName: String(invoice?.invoiceNumber || "").trim() || null,
          customerId: null,
          customerName: String(invoice?.contact?.name || "Xero customer").trim() || "Xero customer",
          customerEmail: String(invoice?.contact?.emailAddress || "").trim() || null,
          customerVatNumber: null,
          customerPhone: null,
          address1: null,
          address2: null,
          city: null,
          county: null,
          postcode: null,
          country: null,
          reference,
          paymentMethod: "Xero",
          subtotal,
          discountTotal: 0,
          vatAmount,
          total,
          amountPaid,
          balanceDue,
          paymentStatus,
          depositPaid: amountPaid > 0,
          staffId: defaultStaff.id,
          createdAt: parseXeroDate(invoice?.dateString || invoice?.date),
        },
      });

      importedCount += 1;
    }

    return redirect(`/app/invoices?syncStatus=success&syncMessage=Imported%20${importedCount}%20Xero%20invoice(s)`);
  } catch (error: any) {
    console.error("Failed to sync Xero invoices:", error);
    const message = encodeURIComponent(String(error?.message || "Xero sync failed"));
    return redirect(`/app/invoices?syncStatus=error&syncMessage=${message}`);
  }
}

export async function loader({ request }: { request: Request }) {
  try {
    const { admin } = await authenticate.admin(request);

    const url = new URL(request.url);
    const xeroConfigured = Boolean(
      process.env.XERO_CLIENT_ID &&
      process.env.XERO_CLIENT_SECRET &&
      process.env.XERO_REDIRECT_URI,
    );

    const source = String(url.searchParams.get("source") || (xeroConfigured ? "all" : "local"));

    const includeLocal = !xeroConfigured || source !== "custom";
    const includeCustom = xeroConfigured && source !== "local";

    let xeroConnected = false;
    if (xeroConfigured) {
      try {
        const xeroConnection = await getXeroConnection();
        xeroConnected = Boolean(xeroConnection?.tenantId);
      } catch (error) {
        // Keep invoices working even if Xero storage/migrations are unavailable.
        console.error("Failed to load Xero connection status:", error);
        xeroConnected = false;
      }
    }

    const localInvoices = includeLocal
      ? await prisma.sale.findMany({
          orderBy: { createdAt: "desc" },
          select: {
            id: true,
            customerName: true,
            paymentMethod: true,
            total: true,
            createdAt: true,
            shopifyOrderName: true,
            reference: true,
            staffId: true,
          },
        })
      : [];

    const staffIds = Array.from(new Set(localInvoices.map((invoice) => invoice.staffId)));
    const staffRecords = staffIds.length
      ? await prisma.staff.findMany({
          where: { id: { in: staffIds } },
          select: { id: true, name: true },
        })
      : [];

    const staffById = new Map(staffRecords.map((staff) => [staff.id, staff.name]));

    const invoices = localInvoices.map((invoice) => ({
      ...invoice,
      staff: staffById.has(invoice.staffId)
        ? { name: staffById.get(invoice.staffId) }
        : null,
    }));

    const customInvoices = includeCustom
      ? await prisma.workSchedule.findMany({
          where: {
            saleId: null,
            OR: [
              { customInvoiceNumber: { not: null } },
              { customCustomerName: { not: null } },
            ],
          },
          orderBy: { createdAt: "desc" },
          select: {
            id: true,
            customInvoiceNumber: true,
            customCustomerName: true,
            createdAt: true,
            assignedStaff: {
              select: {
                name: true,
              },
            },
          },
        })
      : [];

    const legacyWorksInvoices = await prisma.worksOrder.findMany({
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        customerName: true,
        paymentMethod: true,
        total: true,
        createdAt: true,
        xeroInvoiceNumber: true,
      },
      take: 200,
    });

    let shopifyLegacyInvoices: Array<{
      id: string;
      name: string;
      customerName: string;
      paymentStatus: string;
      total: number;
      createdAt: string;
    }> = [];

    if (
      invoices.length === 0 &&
      customInvoices.length === 0 &&
      legacyWorksInvoices.length === 0
    ) {
      try {
        const response = await admin.graphql(
          `
            query LegacyInvoiceOrders($query: String!) {
              orders(first: 50, query: $query, reverse: true, sortKey: CREATED_AT) {
                edges {
                  node {
                    id
                    name
                    createdAt
                    displayFinancialStatus
                    customer {
                      displayName
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
          { variables: { query: "tag:'Invoice App'" } },
        );

        const json = (await response.json()) as any;
        shopifyLegacyInvoices =
          json?.data?.orders?.edges?.map((edge: any) => ({
            id: String(edge?.node?.id || ""),
            name: String(edge?.node?.name || "-") || "-",
            customerName:
              String(edge?.node?.customer?.displayName || "Walk-in customer") ||
              "Walk-in customer",
            paymentStatus: String(edge?.node?.displayFinancialStatus || "-") || "-",
            total: Number(edge?.node?.currentTotalPriceSet?.shopMoney?.amount ?? 0),
            createdAt: String(edge?.node?.createdAt || new Date().toISOString()),
          })) || [];
      } catch (error) {
        console.error("Failed to load legacy Shopify invoice orders:", error);
        shopifyLegacyInvoices = [];
      }
    }

    return {
      invoices,
      customInvoices,
      legacyWorksInvoices,
      shopifyLegacyInvoices,
      source,
      xeroConnected,
      xeroConfigured,
      error: null,
    };
  } catch (error) {
    if (error instanceof Response) {
      throw error;
    }

    console.error("Failed to load invoices:", error);
    return {
      invoices: [],
      customInvoices: [],
      legacyWorksInvoices: [],
      shopifyLegacyInvoices: [],
      source: "local",
      xeroConnected: false,
      xeroConfigured: false,
      error: "Invoices could not be loaded right now.",
    };
  }
}

export default function InvoicesPage() {
  const {
    invoices,
    customInvoices,
    legacyWorksInvoices,
    shopifyLegacyInvoices,
    source,
    xeroConnected,
    xeroConfigured,
    error,
  } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const syncStatus = searchParams.get("syncStatus");
  const syncMessage = searchParams.get("syncMessage");
  const connectXero = searchParams.get("connectXero") === "1";

  return (
    <AppProvider i18n={{}}>
      <Page title="Invoices">
        <Layout>
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    Saved invoices
                  </Text>

                  <InlineStack gap="200" blockAlign="center">
                    {xeroConfigured ? (
                      <>
                        <Form method="post">
                          <input type="hidden" name="_intent" value="syncXero" />
                          <Button submit disabled={!xeroConnected}>Sync Xero</Button>
                        </Form>

                        {!xeroConnected ? (
                          <Button onClick={() => navigate("/app/xero/connect")}>Connect Xero</Button>
                        ) : null}
                      </>
                    ) : null}

                    <Button
                      variant="primary"
                      onClick={() => navigate("/app/invoice")}
                    >
                      Create Invoice
                    </Button>
                  </InlineStack>
                </InlineStack>

                {xeroConfigured ? (
                  <Form method="get">
                    <Select
                      label="Invoice source"
                      name="source"
                      value={source}
                      options={[
                        { label: "Local + custom/Xero", value: "all" },
                        { label: "Local only", value: "local" },
                        { label: "Custom/Xero only", value: "custom" },
                      ]}
                      onChange={(value) => navigate(`/app/invoices?source=${value}`)}
                    />
                  </Form>
                ) : null}
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section>
            {error ? (
              <Banner tone="critical">{error}</Banner>
            ) : null}

            {syncStatus && syncMessage ? (
              <Banner tone={syncStatus === "success" ? "success" : "critical"}>
                {syncMessage}
              </Banner>
            ) : null}

            {xeroConfigured && (!xeroConnected || connectXero) ? (
              <Banner tone="warning">
                Xero is not connected yet. Connect Xero first, then run Sync Xero.
                <div style={{ marginTop: 8 }}>
                  <Button onClick={() => navigate("/app/xero/connect")}>Open Xero connect</Button>
                </div>
              </Banner>
            ) : null}

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
                      <BlockStack gap="100">
                        <Text as="span" fontWeight="bold">
                          INV-{invoice.id}
                        </Text>

                        {invoice.shopifyOrderName ? (
                          <Text as="span" tone="subdued">
                            {invoice.shopifyOrderName}
                          </Text>
                        ) : null}

                        {invoice.reference?.startsWith("XERO:") ? (
                          <Text as="span" tone="subdued">
                            Synced from Xero
                          </Text>
                        ) : null}
                      </BlockStack>
                    </IndexTable.Cell>

                    <IndexTable.Cell>{invoice.customerName}</IndexTable.Cell>

                    <IndexTable.Cell>
                      {invoice.staff?.name || "-"}
                    </IndexTable.Cell>

                    <IndexTable.Cell>{invoice.paymentMethod}</IndexTable.Cell>

                    <IndexTable.Cell>
                      £{Number(invoice.total ?? 0).toFixed(2)}
                    </IndexTable.Cell>

                    <IndexTable.Cell>
                      {new Date(invoice.createdAt).toLocaleString()}
                    </IndexTable.Cell>

                    <IndexTable.Cell>
                      <InlineStack gap="200">
                        <Button onClick={() => navigate(`/app/invoices/${invoice.id}`)}>
                            View
                        </Button>

<Button
  onClick={() => navigate(`/app/invoice?editInvoiceId=${invoice.id}`)}
>
  Edit
</Button>
                      </InlineStack>
                    </IndexTable.Cell>
                  </IndexTable.Row>
                ))}
              </IndexTable>
            </Card>

            {customInvoices.length > 0 ? (
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    Custom / Xero invoices (from schedule)
                  </Text>

                  <IndexTable
                    resourceName={{ singular: "custom invoice", plural: "custom invoices" }}
                    itemCount={customInvoices.length}
                    headings={[
                      { title: "Invoice" },
                      { title: "Customer" },
                      { title: "Assigned staff" },
                      { title: "Date" },
                    ]}
                    selectable={false}
                  >
                    {customInvoices.map((invoice: any, index: number) => (
                      <IndexTable.Row
                        id={`custom-${invoice.id}`}
                        key={`custom-${invoice.id}`}
                        position={index}
                      >
                        <IndexTable.Cell>
                          {invoice.customInvoiceNumber || `Custom-${invoice.id}`}
                        </IndexTable.Cell>
                        <IndexTable.Cell>{invoice.customCustomerName || "-"}</IndexTable.Cell>
                        <IndexTable.Cell>{invoice.assignedStaff?.name || "-"}</IndexTable.Cell>
                        <IndexTable.Cell>
                          {new Date(invoice.createdAt).toLocaleString()}
                        </IndexTable.Cell>
                      </IndexTable.Row>
                    ))}
                  </IndexTable>
                </BlockStack>
              </Card>
            ) : null}

            {legacyWorksInvoices.length > 0 ? (
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    Legacy invoices (works orders)
                  </Text>

                  <IndexTable
                    resourceName={{ singular: "legacy invoice", plural: "legacy invoices" }}
                    itemCount={legacyWorksInvoices.length}
                    headings={[
                      { title: "Invoice" },
                      { title: "Customer" },
                      { title: "Payment" },
                      { title: "Total" },
                      { title: "Date" },
                      { title: "Actions" },
                    ]}
                    selectable={false}
                  >
                    {legacyWorksInvoices.map((invoice: any, index: number) => (
                      <IndexTable.Row
                        id={`legacy-${invoice.id}`}
                        key={`legacy-${invoice.id}`}
                        position={index}
                      >
                        <IndexTable.Cell>
                          {invoice.xeroInvoiceNumber || `WORK-${invoice.id}`}
                        </IndexTable.Cell>
                        <IndexTable.Cell>{invoice.customerName || "-"}</IndexTable.Cell>
                        <IndexTable.Cell>{invoice.paymentMethod || "-"}</IndexTable.Cell>
                        <IndexTable.Cell>
                          £{Number(invoice.total ?? 0).toFixed(2)}
                        </IndexTable.Cell>
                        <IndexTable.Cell>
                          {new Date(invoice.createdAt).toLocaleString()}
                        </IndexTable.Cell>
                        <IndexTable.Cell>
                          <Button onClick={() => navigate(`/app/works/${invoice.id}`)}>
                            View
                          </Button>
                        </IndexTable.Cell>
                      </IndexTable.Row>
                    ))}
                  </IndexTable>
                </BlockStack>
              </Card>
            ) : null}

            {shopifyLegacyInvoices.length > 0 ? (
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    Legacy invoices (Shopify tagged orders)
                  </Text>

                  <IndexTable
                    resourceName={{ singular: "shopify invoice", plural: "shopify invoices" }}
                    itemCount={shopifyLegacyInvoices.length}
                    headings={[
                      { title: "Order" },
                      { title: "Customer" },
                      { title: "Payment" },
                      { title: "Total" },
                      { title: "Date" },
                    ]}
                    selectable={false}
                  >
                    {shopifyLegacyInvoices.map((invoice: any, index: number) => (
                      <IndexTable.Row
                        id={`shopify-${invoice.id}`}
                        key={`shopify-${invoice.id}`}
                        position={index}
                      >
                        <IndexTable.Cell>{invoice.name}</IndexTable.Cell>
                        <IndexTable.Cell>{invoice.customerName || "-"}</IndexTable.Cell>
                        <IndexTable.Cell>{invoice.paymentStatus || "-"}</IndexTable.Cell>
                        <IndexTable.Cell>£{Number(invoice.total ?? 0).toFixed(2)}</IndexTable.Cell>
                        <IndexTable.Cell>
                          {new Date(invoice.createdAt).toLocaleString()}
                        </IndexTable.Cell>
                      </IndexTable.Row>
                    ))}
                  </IndexTable>
                </BlockStack>
              </Card>
            ) : null}

            {invoices.length === 0 &&
            customInvoices.length === 0 &&
            legacyWorksInvoices.length === 0 &&
            shopifyLegacyInvoices.length === 0 ? (
              <Banner tone="info">
                No invoices were found in local Sales, legacy Works Orders, custom schedule invoices, or Shopify tagged orders.
              </Banner>
            ) : null}
          </Layout.Section>
        </Layout>
      </Page>
    </AppProvider>
  );
}