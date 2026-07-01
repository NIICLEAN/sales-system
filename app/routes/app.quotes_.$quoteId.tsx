import { useEffect } from "react";
import { useLoaderData, useNavigate, useSearchParams, redirect } from "react-router";
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
  Banner,
} from "@shopify/polaris";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { adjustInventoryForLineItems } from "../services/shopifyInventory.server";
import { createSaleCompat } from "../services/saleCompat.server";

function money(value: any) {
  return `£${Number(value ?? 0).toFixed(2)}`;
}

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { quoteId: string };
}) {
  try {
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
      error: null,
    };
  } catch (error) {
    if (error instanceof Response) throw error;
    console.error("Failed to load quote:", error);
    return {
      quote: null,
      logoUrl: "",
      error: "Quote could not be loaded right now.",
    };
  }
}

export async function action({ request, params }: { request: Request; params: { quoteId: string } }) {
  const { admin } = await authenticate.admin(request);

  const quoteId = Number(params.quoteId);

  const quote = await prisma.quote.findUnique({
    where: { id: quoteId },
    include: { lineItems: true },
  });

  if (!quote) {
    throw new Response("Quote not found", { status: 404 });
  }

  const vatType = (quote as any).vatType || "Standard";
  const isVatExempt = vatType === "Exempt" || vatType === "CrossBorder";

  const draftOrderInput: any = {
    customerId: undefined,
    email: quote.customerEmail || undefined,
    phone: quote.customerPhone || undefined,
    taxExempt: isVatExempt,
    note: quote.reference || undefined,
    tags: ["Quote Converted"],
    lineItems: quote.lineItems.map((item: any) => {
      const netUnitPrice = Math.round(Number(item.unitPrice || 0) * 100) / 100;

      return {
        quantity: Number(item.quantity || 1),
        title: item.title || "Custom item",
        sku: item.sku || undefined,
        originalUnitPriceWithCurrency: {
          amount: Number(netUnitPrice ?? 0).toFixed(2),
          currencyCode: "GBP",
        },
        taxable: vatType === "Standard",
        appliedDiscount: Number(item.discount || 0)
          ? {
              value: Number(item.discount || 0),
              valueType: "FIXED_AMOUNT",
              title: "Manual discount",
            }
          : null,
      };
    }),
  };

  const createDraftResponse = await admin.graphql(
    `
      mutation CreateDraftOrder($input: DraftOrderInput!) {
        draftOrderCreate(input: $input) {
          draftOrder { id name }
          userErrors { field message }
        }
      }
    `,
    { variables: { input: draftOrderInput } },
  );

  const createDraftJson = await createDraftResponse.json();

  const createErrors = createDraftJson.data?.draftOrderCreate?.userErrors || [];

  if (createErrors.length > 0) {
    throw new Response(createErrors.map((e: any) => e.message).join(", "), { status: 400 });
  }

  const draftOrderId = createDraftJson.data.draftOrderCreate.draftOrder.id;

  const completeDraftResponse = await admin.graphql(
    `
      mutation CompleteDraftOrder($id: ID!, $paymentPending: Boolean!) {
        draftOrderComplete(id: $id, paymentPending: $paymentPending) {
          draftOrder { id order { id name } }
          userErrors { field message }
        }
      }
    `,
    { variables: { id: draftOrderId, paymentPending: true } },
  );

  const completeDraftJson = await completeDraftResponse.json();

  const completeErrors = completeDraftJson.data?.draftOrderComplete?.userErrors || [];

  if (completeErrors.length > 0) {
    throw new Response(completeErrors.map((e: any) => e.message).join(", "), { status: 400 });
  }

  const shopifyOrder = completeDraftJson.data.draftOrderComplete.draftOrder.order;

  const sale = await createSaleCompat({
    sale: {
      shopifyOrderId: shopifyOrder?.id || null,
      shopifyOrderName: shopifyOrder?.name || null,
      customerId: null,
      customerName: quote.customerName,
      customerEmail: quote.customerEmail,
      customerVatNumber: (quote as any).customerVatNumber || null,
      customerPhone: quote.customerPhone,
      address1: quote.address1,
      address2: quote.address2,
      city: quote.city,
      county: quote.county,
      postcode: quote.postcode,
      country: quote.country,
      reference: quote.reference,
      paymentMethod: "Other",
      subtotal: quote.subtotal,
      discountTotal: quote.discountTotal,
      vatAmount: quote.vatAmount,
      total: quote.total,
      amountPaid: 0,
      balanceDue: quote.total,
      paymentStatus: "Unpaid",
      depositPaid: false,
      staffId: quote.staffId,
    },
    lineItems: quote.lineItems.map((item: any) => ({
          shopifyVariantId: item.shopifyVariantId || null,
          title: item.title,
          sku: item.sku,
          imageUrl: null,
          quantity: item.quantity,
          unitPrice: Number(item.unitPrice),
          discount: Number(item.discount || 0),
          lineTotal: item.lineTotal,
          isCustom: !item.shopifyVariantId,
        })),
  });

  // Adjust inventory for non-custom items
  try {
    const variantAdjustments = quote.lineItems
      .filter((li: any) => li.shopifyVariantId)
      .map((li: any) => ({ id: li.shopifyVariantId, quantity: Number(li.quantity) }));

    if (variantAdjustments.length > 0) {
      await adjustInventoryForLineItems(admin, variantAdjustments);
    }
  } catch (err) {
    console.error("Inventory adjustment failed on quote->invoice convert:", err);
  }

  // send invoice email if customer has email
  if (quote.customerEmail) {
    try {
      const { generateInvoicePdf } = await import("../utils/invoice-pdf.server");
      const { sendInvoiceEmail } = await import("../utils/email.server");

      const pdfBuffer = await generateInvoicePdf(sale.id);

      await sendInvoiceEmail({
        to: quote.customerEmail,
        customerName: quote.customerName,
        invoiceId: sale.id,
        pdfBuffer,
        paymentStatus: "Unpaid",
      });
    } catch (err) {
      console.error("Failed to send invoice email after conversion:", err);
    }
  }

  return redirect(`/app/invoices/${sale.id}`);
}

export default function QuoteViewPage() {
  const { quote, error } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const loadedQuote = quote;

  if (error || !loadedQuote) {
    return <Banner tone="critical">{error || "Quote not found."}</Banner>;
  }

  useEffect(() => {
    if (searchParams.get("autoprint") !== "1") return;

    const timer = window.setTimeout(() => {
      navigate(`/app/quotes/${quote.id}/print?autoprint=1`);
    }, 400);

    return () => window.clearTimeout(timer);
  }, [searchParams, navigate, loadedQuote.id]);

  return (
    <Page
      title={`Quote QUO-${loadedQuote.id}`}
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
                      QUO-{loadedQuote.id}
                    </Text>
                    <Text as="p" tone="subdued">
                      Created {new Date(loadedQuote.createdAt).toLocaleString("en-GB")}
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

                  <form method="post" style={{ display: "inline" }}>
                    <button
                      type="submit"
                      style={{
                        background: "#006aff",
                        color: "white",
                        border: "none",
                        padding: "8px 12px",
                        borderRadius: 4,
                        cursor: "pointer",
                        marginRight: 8,
                      }}
                    >
                      Convert to Invoice
                    </button>
                  </form>

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