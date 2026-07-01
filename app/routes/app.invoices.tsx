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

function mapLegacyPaymentStatus(value: unknown) {
  const status = String(value || "").toLowerCase();
  if (status === "paid") return "Paid";
  if (status === "part_paid" || status === "partially_paid") return "Partially Paid";
  return "Unpaid";
}

function parseMoneyString(value: unknown) {
  const normalized = String(value || "").replace(/[^0-9.-]/g, "");
  const amount = Number(normalized);
  return Number.isFinite(amount) ? amount : 0;
}

function getCustomAttributeValue(attributes: Array<{ key?: string | null; value?: string | null }> | null | undefined, key: string) {
  const match = attributes?.find((attribute) => String(attribute?.key || "").trim().toLowerCase() === key.toLowerCase());
  return String(match?.value || "").trim();
}

export async function action({ request }: ActionFunctionArgs) {
  const { admin } = await authenticate.admin(request);

  const formData = await request.formData();
  const intent = String(formData.get("_intent") || "");

  if (intent === "openShopifyLegacyInEditor") {
    const shopifyOrderId = String(formData.get("shopifyOrderId") || "").trim();
    const legacyResourceId = String(formData.get("legacyResourceId") || "").trim();

    if (!shopifyOrderId) {
      return redirect("/app/invoices?syncStatus=error&syncMessage=Invalid%20Shopify%20invoice%20selection");
    }

    try {
      const reference = legacyResourceId ? `SHOPIFY:${legacyResourceId}` : `SHOPIFY:${shopifyOrderId}`;

      const existingSale = await prisma.sale.findFirst({
        where: {
          OR: [
            { shopifyOrderId },
            { reference },
          ],
        },
        select: { id: true },
      });

      if (existingSale) {
        return redirect(`/app/invoice?editInvoiceId=${existingSale.id}`);
      }

      const response = await admin.graphql(
        `
          query LegacyInvoiceOrder($id: ID!) {
            order(id: $id) {
              id
              name
              note
              createdAt
              displayFinancialStatus
              customAttributes {
                key
                value
              }
              customer {
                id
                displayName
                email
                phone
              }
              shippingAddress {
                address1
                address2
                city
                province
                zip
                country
                phone
              }
              currentSubtotalPriceSet {
                shopMoney {
                  amount
                }
              }
              currentTotalDiscountsSet {
                shopMoney {
                  amount
                }
              }
              currentTotalTaxSet {
                shopMoney {
                  amount
                }
              }
              currentTotalPriceSet {
                shopMoney {
                  amount
                }
              }
              lineItems(first: 100) {
                edges {
                  node {
                    name
                    sku
                    quantity
                    image {
                      url
                    }
                    variant {
                      id
                    }
                    originalUnitPriceSet {
                      shopMoney {
                        amount
                      }
                    }
                    discountedUnitPriceAfterAllDiscountsSet {
                      shopMoney {
                        amount
                      }
                    }
                  }
                }
              }
            }
          }
        `,
        { variables: { id: shopifyOrderId } },
      );

      const json = (await response.json()) as any;
      const order = json?.data?.order;

      if (!order) {
        return redirect("/app/invoices?syncStatus=error&syncMessage=Shopify%20invoice%20order%20not%20found");
      }

      const customAttributes = order.customAttributes ?? [];
      const salespersonId = Number(getCustomAttributeValue(customAttributes, "Salesperson ID") || 0);
      const defaultStaff = await prisma.staff.findFirst({ orderBy: { id: "asc" } });
      const staffExists = salespersonId
        ? await prisma.staff.findUnique({
            where: { id: salespersonId },
            select: { id: true },
          })
        : null;

      if (!defaultStaff && !staffExists) {
        return redirect("/app/invoices?syncStatus=error&syncMessage=No%20staff%20record%20exists");
      }

      const total = toNumber(order?.currentTotalPriceSet?.shopMoney?.amount);
      const amountPaid = parseMoneyString(getCustomAttributeValue(customAttributes, "Amount Paid"));
      const paymentMethod = getCustomAttributeValue(customAttributes, "Payment Method") || "Other";
      const depositPaidAttr = getCustomAttributeValue(customAttributes, "Deposit Paid").toLowerCase();
      const depositPaid = depositPaidAttr === "yes" || (amountPaid > 0 && amountPaid < total);

      const createdSale = await prisma.sale.create({
        data: {
          shopifyOrderId: order.id,
          shopifyOrderName: order.name || null,
          customerId: order.customer?.id || null,
          customerName: order.customer?.displayName || "Walk-in customer",
          customerEmail: order.customer?.email || null,
          customerVatNumber: getCustomAttributeValue(customAttributes, "VAT Number") || null,
          customerPhone: order.customer?.phone || order.shippingAddress?.phone || null,
          address1: order.shippingAddress?.address1 || null,
          address2: order.shippingAddress?.address2 || null,
          city: order.shippingAddress?.city || null,
          county: order.shippingAddress?.province || null,
          postcode: order.shippingAddress?.zip || null,
          country: order.shippingAddress?.country || null,
          reference,
          paymentMethod,
          subtotal: toNumber(order?.currentSubtotalPriceSet?.shopMoney?.amount),
          discountTotal: toNumber(order?.currentTotalDiscountsSet?.shopMoney?.amount),
          vatAmount: toNumber(order?.currentTotalTaxSet?.shopMoney?.amount),
          total,
          amountPaid,
          balanceDue: Math.max(total - amountPaid, 0),
          paymentStatus: mapLegacyPaymentStatus(getCustomAttributeValue(customAttributes, "Payment Status") || order.displayFinancialStatus),
          depositPaid,
          staffId: staffExists?.id || defaultStaff!.id,
          createdAt: parseXeroDate(order.createdAt),
          lineItems: {
            create: (order.lineItems?.edges || []).map((edge: any) => {
              const node = edge?.node;
              const originalUnitPrice = toNumber(node?.originalUnitPriceSet?.shopMoney?.amount);
              const discountedUnitPrice = toNumber(node?.discountedUnitPriceAfterAllDiscountsSet?.shopMoney?.amount);
              const quantity = Number(node?.quantity || 0);
              const lineDiscount = Math.max((originalUnitPrice - discountedUnitPrice) * quantity, 0);

              return {
                shopifyVariantId: node?.variant?.id || null,
                title: String(node?.name || "Item"),
                sku: node?.sku || null,
                imageUrl: node?.image?.url || null,
                quantity,
                unitPrice: originalUnitPrice,
                discount: lineDiscount,
                lineTotal: Math.max(discountedUnitPrice * quantity, 0),
                isCustom: !node?.variant?.id,
              };
            }),
          },
        },
      });

      return redirect(`/app/invoice?editInvoiceId=${createdSale.id}`);
    } catch (error: any) {
      console.error("Failed to open Shopify legacy invoice in editor:", error);
      const message = encodeURIComponent(String(error?.message || "Failed to open Shopify legacy invoice"));
      return redirect(`/app/invoices?syncStatus=error&syncMessage=${message}`);
    }
  }

  if (intent === "openLegacyInEditor") {
    const worksOrderId = Number(formData.get("worksOrderId") || 0);

    if (!worksOrderId) {
      return redirect("/app/invoices?syncStatus=error&syncMessage=Invalid%20legacy%20invoice%20selection");
    }

    try {
      const reference = `WORKS:${worksOrderId}`;

      const existingSale = await prisma.sale.findFirst({
        where: { reference },
        select: { id: true },
      });

      if (existingSale) {
        return redirect(`/app/invoice?editInvoiceId=${existingSale.id}`);
      }

      const worksOrder = await prisma.worksOrder.findUnique({
        where: { id: worksOrderId },
        include: { lineItems: true },
      });

      if (!worksOrder) {
        return redirect("/app/invoices?syncStatus=error&syncMessage=Legacy%20invoice%20not%20found");
      }

      const defaultStaff = await prisma.staff.findFirst({ orderBy: { id: "asc" } });
      const staffExists = worksOrder.salespersonId
        ? await prisma.staff.findUnique({
            where: { id: worksOrder.salespersonId },
            select: { id: true },
          })
        : null;

      if (!defaultStaff && !staffExists) {
        return redirect("/app/invoices?syncStatus=error&syncMessage=No%20staff%20record%20exists");
      }

      const total = Number(worksOrder.total ?? 0);
      const amountPaid = Number(worksOrder.amountPaid ?? 0);

      const createdSale = await prisma.sale.create({
        data: {
          shopifyOrderId: null,
          shopifyOrderName: worksOrder.xeroInvoiceNumber || null,
          customerId: worksOrder.customerId || null,
          customerName: worksOrder.customerName || "Walk-in customer",
          customerEmail: worksOrder.customerEmail || null,
          customerVatNumber: worksOrder.customerVatNumber || null,
          customerPhone: worksOrder.customerPhone || null,
          address1: worksOrder.address1 || null,
          address2: worksOrder.address2 || null,
          city: worksOrder.city || null,
          county: worksOrder.county || null,
          postcode: worksOrder.postcode || null,
          country: worksOrder.country || null,
          reference,
          paymentMethod: worksOrder.paymentMethod || "Other",
          subtotal: Number(worksOrder.subtotal ?? 0),
          discountTotal: Number(worksOrder.discountTotal ?? 0),
          vatAmount: Number(worksOrder.vatAmount ?? 0),
          total,
          amountPaid,
          balanceDue: Math.max(total - amountPaid, 0),
          paymentStatus: mapLegacyPaymentStatus(worksOrder.paymentStatus),
          depositPaid: amountPaid > 0 && amountPaid < total,
          staffId: staffExists?.id || defaultStaff!.id,
          createdAt: worksOrder.createdAt,
          lineItems: {
            create: worksOrder.lineItems.map((item) => ({
              shopifyVariantId: item.shopifyVariantId || null,
              title: item.title,
              sku: item.sku || null,
              imageUrl: null,
              quantity: Number(item.quantity || 0),
              unitPrice: Number(item.unitPrice ?? 0),
              discount: Number(item.discount ?? 0),
              lineTotal: Number(item.lineTotal ?? 0),
              isCustom: !item.shopifyVariantId,
            })),
          },
        },
      });

      return redirect(`/app/invoice?editInvoiceId=${createdSale.id}`);
    } catch (error: any) {
      console.error("Failed to open legacy invoice in editor:", error);
      const message = encodeURIComponent(String(error?.message || "Failed to open legacy invoice"));
      return redirect(`/app/invoices?syncStatus=error&syncMessage=${message}`);
    }
  }

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
    const shopDomain = String(
      url.searchParams.get("shop") || request.headers.get("x-shopify-shop-domain") || "",
    ).trim();
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
      legacyResourceId: string | null;
      name: string;
      customerName: string;
      paymentStatus: string;
      total: number;
      createdAt: string;
      adminOrderPath: string | null;
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
                    legacyResourceId
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
            adminOrderPath:
              edge?.node?.legacyResourceId && shopDomain
                ? `https://${shopDomain}/admin/orders/${edge.node.legacyResourceId}`
                : null,
            id: String(edge?.node?.id || ""),
            legacyResourceId: edge?.node?.legacyResourceId ? String(edge.node.legacyResourceId) : null,
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

  function openAdminPath(path: string) {
    if (typeof window === "undefined") return;
    if (window.top) {
      window.top.location.href = path;
      return;
    }
    window.location.href = path;
  }

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
                      { title: "Actions" },
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
                        <IndexTable.Cell>
                          <Button onClick={() => navigate("/app/schedule")}>
                            Open Schedule
                          </Button>
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
                          <InlineStack gap="200">
                            <Button onClick={() => navigate(`/app/works/${invoice.id}`)}>
                              Open
                            </Button>
                            <Form method="post">
                              <input type="hidden" name="_intent" value="openLegacyInEditor" />
                              <input type="hidden" name="worksOrderId" value={invoice.id} />
                              <Button submit>Edit Invoices</Button>
                            </Form>
                          </InlineStack>
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
                      { title: "Actions" },
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
                        <IndexTable.Cell>
                          {invoice.adminOrderPath ? (
                            <InlineStack gap="200">
                              <Form method="post">
                                <input type="hidden" name="_intent" value="openShopifyLegacyInEditor" />
                                <input type="hidden" name="shopifyOrderId" value={invoice.id} />
                                <input type="hidden" name="legacyResourceId" value={invoice.legacyResourceId || ""} />
                                <Button submit>Edit Invoice</Button>
                              </Form>
                              <Button onClick={() => openAdminPath(invoice.adminOrderPath)}>
                                Open Order
                              </Button>
                            </InlineStack>
                          ) : (
                            <Form method="post">
                              <input type="hidden" name="_intent" value="openShopifyLegacyInEditor" />
                              <input type="hidden" name="shopifyOrderId" value={invoice.id} />
                              <input type="hidden" name="legacyResourceId" value={invoice.legacyResourceId || ""} />
                              <Button submit>Edit Invoice</Button>
                            </Form>
                          )}
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