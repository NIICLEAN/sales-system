import { Form, useLoaderData, redirect } from "react-router";
import { useMemo, useState } from "react";
import {
  AppProvider,
  Page,
  Layout,
  Card,
  TextField,
  Button,
  Select,
  BlockStack,
  InlineStack,
  IndexTable,
  Text,
  Badge,
  Divider,
  Checkbox,
} from "@shopify/polaris";
import "@shopify/polaris/build/esm/styles.css";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export async function loader({ request }: { request: Request }) {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const productSearch = url.searchParams.get("productSearch") || "";

  const staff = await prisma.staff.findMany({
    orderBy: { name: "asc" },
  });

  let variants: any[] = [];

  if (productSearch.trim()) {
    const productsResponse = await admin.graphql(
      `
        query ProductVariants($query: String) {
          productVariants(first: 25, query: $query) {
            edges {
              node {
                id
                title
                sku
                price
                product {
                  title
                }
              }
            }
          }
        }
      `,
      {
        variables: {
          query: productSearch,
        },
      }
    );

    const productsJson = await productsResponse.json();

    variants =
      productsJson.data.productVariants.edges.map((edge: any) => edge.node) ||
      [];
  }

  return {
    staff,
    variants,
    productSearch,
  };
}

export async function action({ request }: { request: Request }) {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();

  const staffId = Number(formData.get("staffId"));
  const customerName =
    String(formData.get("customerName") || "").trim() || "Walk-in customer";
  const customerEmail = String(formData.get("customerEmail") || "").trim();
  const customerPhone = String(formData.get("customerPhone") || "").trim();

  const address1 = String(formData.get("address1") || "").trim();
  const address2 = String(formData.get("address2") || "").trim();
  const city = String(formData.get("city") || "").trim();
  const county = String(formData.get("county") || "").trim();
  const postcode = String(formData.get("postcode") || "").trim();
  const country = String(formData.get("country") || "").trim();

  const reference = String(formData.get("reference") || "").trim();
  const lineItems = JSON.parse(String(formData.get("lineItems") || "[]"));

  if (!staffId || lineItems.length === 0) {
    return redirect("/app/quote");
  }

  const subtotal = lineItems.reduce(
    (sum: number, item: any) =>
      sum + Number(item.unitPrice) * Number(item.quantity),
    0
  );

  const discountTotal = lineItems.reduce(
    (sum: number, item: any) => sum + Number(item.discount || 0),
    0
  );

  const netTotal = subtotal - discountTotal;
  const vatAmount = netTotal * 0.2;
  const total = netTotal + vatAmount;

  const quote = await prisma.quote.create({
    data: {
      customerName,
      customerEmail,
      customerPhone,
      address1,
      address2,
      city,
      county,
      postcode,
      country,
      reference,
      subtotal,
      discountTotal,
      vatAmount,
      total,
      staffId,
      lineItems: {
        create: lineItems.map((item: any) => ({
          shopifyVariantId: item.id,
          title: item.title,
          sku: item.sku,
          quantity: Number(item.quantity),
          unitPrice: Number(item.unitPrice),
          discount: Number(item.discount || 0),
          lineTotal:
            Number(item.unitPrice) * Number(item.quantity) -
            Number(item.discount || 0),
        })),
      },
    },
  });

  if (customerEmail) {
    try {
      const { generateQuotePdf } = await import("../utils/quote-pdf.server");
      const { sendQuoteEmail } = await import("../utils/email.server");

      const pdfBuffer = await generateQuotePdf(quote.id);

      await sendQuoteEmail({
        to: customerEmail,
        customerName,
        quoteId: quote.id,
        pdfBuffer,
      });
    } catch (error) {
      console.error("Quote email failed:", error);
    }
  }

  return redirect(`/app/quotes/${quote.id}?autoprint=1`);
}

export default function QuotePage() {
  const { staff, variants, productSearch } = useLoaderData<typeof loader>();

  const [searchTerm, setSearchTerm] = useState(productSearch || "");
  const [staffId, setStaffId] = useState(
    staff[0]?.id ? String(staff[0].id) : ""
  );

  const [customerName, setCustomerName] = useState("");
  const [customerEmail, setCustomerEmail] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");

  const [addressOpen, setAddressOpen] = useState(false);
  const [address1, setAddress1] = useState("");
  const [address2, setAddress2] = useState("");
  const [city, setCity] = useState("");
  const [county, setCounty] = useState("");
  const [postcode, setPostcode] = useState("");
  const [country, setCountry] = useState("United Kingdom");

  const [reference, setReference] = useState("");
  const [items, setItems] = useState<any[]>([]);

  const staffOptions = staff.map((person: any) => ({
    label: person.name,
    value: String(person.id),
  }));

  function addItem(variant: any) {
    setItems((current) => [
      ...current,
      {
        id: variant.id,
        title: `${variant.product.title} - ${variant.title}`,
        sku: variant.sku || "",
        quantity: 1,
        unitPrice: Number(variant.price || 0),
        discount: 0,
      },
    ]);
  }

  function updateItem(index: number, key: string, value: string) {
    setItems((current) =>
      current.map((item, itemIndex) =>
        itemIndex === index ? { ...item, [key]: value } : item
      )
    );
  }

  function removeItem(index: number) {
    setItems((current) => current.filter((_, itemIndex) => itemIndex !== index));
  }

  const totals = useMemo(() => {
    const subtotal = items.reduce(
      (sum, item) => sum + Number(item.unitPrice) * Number(item.quantity),
      0
    );

    const discount = items.reduce(
      (sum, item) => sum + Number(item.discount || 0),
      0
    );

    const netTotal = subtotal - discount;
    const vatAmount = netTotal * 0.2;

    return {
      subtotal,
      discount,
      netTotal,
      vatAmount,
      total: netTotal + vatAmount,
    };
  }, [items]);

  return (
    <AppProvider i18n={{}}>
      <Page title="Create Quote">
        <Layout>
          <Layout.Section>
            <BlockStack gap="400">
              <Card>
                <Form method="get">
                  <BlockStack gap="300">
                    <Text as="h2" variant="headingMd">
                      Search products
                    </Text>

                    <InlineStack gap="300" blockAlign="end">
                      <div style={{ flex: 1 }}>
                        <TextField
                          label="Product name or SKU"
                          labelHidden
                          name="productSearch"
                          value={searchTerm}
                          onChange={setSearchTerm}
                          autoComplete="off"
                          placeholder="Search by product name or SKU"
                        />
                      </div>

                      <Button submit>Search Product</Button>
                    </InlineStack>
                  </BlockStack>
                </Form>
              </Card>

              {productSearch && (
                <Card>
                  <BlockStack gap="300">
                    <Text as="h2" variant="headingMd">
                      Search results
                    </Text>

                    <IndexTable
                      resourceName={{
                        singular: "product",
                        plural: "products",
                      }}
                      itemCount={variants.length}
                      headings={[
                        { title: "Product" },
                        { title: "SKU" },
                        { title: "Price" },
                        { title: "Action" },
                      ]}
                      selectable={false}
                    >
                      {variants.map((variant: any, index: number) => (
                        <IndexTable.Row
                          id={variant.id}
                          key={variant.id}
                          position={index}
                        >
                          <IndexTable.Cell>
                            {variant.product.title} - {variant.title}
                          </IndexTable.Cell>
                          <IndexTable.Cell>{variant.sku || "-"}</IndexTable.Cell>
                          <IndexTable.Cell>£{variant.price}</IndexTable.Cell>
                          <IndexTable.Cell>
                            <Button onClick={() => addItem(variant)}>Add</Button>
                          </IndexTable.Cell>
                        </IndexTable.Row>
                      ))}
                    </IndexTable>
                  </BlockStack>
                </Card>
              )}

              <Card>
                <BlockStack gap="400">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="h2" variant="headingMd">
                      Quote lines
                    </Text>

                    <Button disabled>Add custom item</Button>
                  </InlineStack>

                  <Divider />

                  {items.length === 0 ? (
                    <Text as="p" tone="subdued">
                      No items added yet. Search for a Shopify product above to
                      start building the quote.
                    </Text>
                  ) : (
                    <IndexTable
                      resourceName={{
                        singular: "quote line",
                        plural: "quote lines",
                      }}
                      itemCount={items.length}
                      headings={[
                        { title: "Product" },
                        { title: "SKU" },
                        { title: "Qty" },
                        { title: "Unit price" },
                        { title: "Discount" },
                        { title: "Line total" },
                        { title: "" },
                      ]}
                      selectable={false}
                    >
                      {items.map((item, index) => {
                        const lineTotal =
                          Number(item.unitPrice) * Number(item.quantity) -
                          Number(item.discount || 0);

                        return (
                          <IndexTable.Row
                            id={`${item.id}-${index}`}
                            key={`${item.id}-${index}`}
                            position={index}
                          >
                            <IndexTable.Cell>{item.title}</IndexTable.Cell>
                            <IndexTable.Cell>{item.sku || "-"}</IndexTable.Cell>
                            <IndexTable.Cell>
                              <div style={{ width: 80 }}>
                                <TextField
                                  label="Qty"
                                  labelHidden
                                  value={String(item.quantity)}
                                  onChange={(value) =>
                                    updateItem(index, "quantity", value)
                                  }
                                  autoComplete="off"
                                  type="number"
                                />
                              </div>
                            </IndexTable.Cell>
                            <IndexTable.Cell>
                              <div style={{ width: 120 }}>
                                <TextField
                                  label="Unit price"
                                  labelHidden
                                  value={String(item.unitPrice)}
                                  onChange={(value) =>
                                    updateItem(index, "unitPrice", value)
                                  }
                                  autoComplete="off"
                                  type="number"
                                  prefix="£"
                                />
                              </div>
                            </IndexTable.Cell>
                            <IndexTable.Cell>
                              <div style={{ width: 120 }}>
                                <TextField
                                  label="Discount"
                                  labelHidden
                                  value={String(item.discount)}
                                  onChange={(value) =>
                                    updateItem(index, "discount", value)
                                  }
                                  autoComplete="off"
                                  type="number"
                                  prefix="£"
                                />
                              </div>
                            </IndexTable.Cell>
                            <IndexTable.Cell>
                              £{lineTotal.toFixed(2)}
                            </IndexTable.Cell>
                            <IndexTable.Cell>
                              <Button
                                tone="critical"
                                variant="plain"
                                onClick={() => removeItem(index)}
                              >
                                Remove
                              </Button>
                            </IndexTable.Cell>
                          </IndexTable.Row>
                        );
                      })}
                    </IndexTable>
                  )}
                </BlockStack>
              </Card>

              <Form method="post">
                <input
                  type="hidden"
                  name="lineItems"
                  value={JSON.stringify(items)}
                />

                <Layout>
                  <Layout.Section>
                    <BlockStack gap="400">
                      <Card>
                        <BlockStack gap="400">
                          <Text as="h2" variant="headingMd">
                            Customer details
                          </Text>

                          <InlineStack gap="300">
                            <div style={{ flex: 1 }}>
                              <TextField
                                label="Customer name"
                                name="customerName"
                                value={customerName}
                                onChange={setCustomerName}
                                autoComplete="off"
                              />
                            </div>

                            <div style={{ flex: 1 }}>
                              <TextField
                                label="Customer email"
                                name="customerEmail"
                                value={customerEmail}
                                onChange={setCustomerEmail}
                                autoComplete="off"
                              />
                            </div>
                          </InlineStack>

                          <TextField
                            label="Customer phone"
                            name="customerPhone"
                            value={customerPhone}
                            onChange={setCustomerPhone}
                            autoComplete="off"
                          />

                          <Button
                            fullWidth
                            onClick={() => setAddressOpen(!addressOpen)}
                          >
                            {addressOpen ? "Hide shipping address" : "Edit shipping address"}
                          </Button>

                          {addressOpen && (
                            <BlockStack gap="300">
                              <TextField
                                label="Address line 1"
                                name="address1"
                                value={address1}
                                onChange={setAddress1}
                                autoComplete="off"
                              />
                              <TextField
                                label="Address line 2"
                                name="address2"
                                value={address2}
                                onChange={setAddress2}
                                autoComplete="off"
                              />
                              <InlineStack gap="300">
                                <div style={{ flex: 1 }}>
                                  <TextField
                                    label="Town / City"
                                    name="city"
                                    value={city}
                                    onChange={setCity}
                                    autoComplete="off"
                                  />
                                </div>
                                <div style={{ flex: 1 }}>
                                  <TextField
                                    label="County"
                                    name="county"
                                    value={county}
                                    onChange={setCounty}
                                    autoComplete="off"
                                  />
                                </div>
                              </InlineStack>
                              <InlineStack gap="300">
                                <div style={{ flex: 1 }}>
                                  <TextField
                                    label="Postcode"
                                    name="postcode"
                                    value={postcode}
                                    onChange={setPostcode}
                                    autoComplete="off"
                                  />
                                </div>
                                <div style={{ flex: 1 }}>
                                  <TextField
                                    label="Country"
                                    name="country"
                                    value={country}
                                    onChange={setCountry}
                                    autoComplete="off"
                                  />
                                </div>
                              </InlineStack>
                            </BlockStack>
                          )}
                        </BlockStack>
                      </Card>

                      <Card>
                        <BlockStack gap="400">
                          <Text as="h2" variant="headingMd">
                            Quote details
                          </Text>

                          <InlineStack gap="300">
                            <div style={{ flex: 1 }}>
                              <Select
                                label="Account / Salesperson"
                                name="staffId"
                                options={staffOptions}
                                value={staffId}
                                onChange={setStaffId}
                              />
                            </div>

                            <div style={{ flex: 1 }}>
                              <Select
                                label="Quote valid for"
                                options={[
                                  { label: "7 days", value: "7" },
                                  { label: "14 days", value: "14" },
                                  { label: "30 days", value: "30" },
                                  { label: "60 days", value: "60" },
                                ]}
                                value="30"
                                onChange={() => {}}
                              />
                            </div>
                          </InlineStack>

                          <TextField
                            label="Reference"
                            name="reference"
                            value={reference}
                            onChange={setReference}
                            autoComplete="off"
                            placeholder="Customer PO, job ref, or note"
                          />
                        </BlockStack>
                      </Card>
                    </BlockStack>
                  </Layout.Section>

                  <Layout.Section variant="oneThird">
                    <div style={{ position: "sticky", top: 20 }}>
                      <Card>
                        <BlockStack gap="400">
                          <InlineStack align="space-between" blockAlign="center">
                            <Text as="h2" variant="headingMd">
                              Summary
                            </Text>
                            <Badge tone="attention">Draft</Badge>
                          </InlineStack>

                          <BlockStack gap="200">
                            <InlineStack align="space-between">
                              <Text as="span">Net subtotal</Text>
                              <Text as="span">£{totals.subtotal.toFixed(2)}</Text>
                            </InlineStack>

                            <InlineStack align="space-between">
                              <Text as="span">Discount</Text>
                              <Text as="span">£{totals.discount.toFixed(2)}</Text>
                            </InlineStack>

                            <InlineStack align="space-between">
                              <Text as="span">Net total</Text>
                              <Text as="span">£{totals.netTotal.toFixed(2)}</Text>
                            </InlineStack>

                            <InlineStack align="space-between">
                              <Text as="span">VAT</Text>
                              <Text as="span">£{totals.vatAmount.toFixed(2)}</Text>
                            </InlineStack>
                          </BlockStack>

                          <Divider />

                          <InlineStack align="space-between">
                            <Text as="span" fontWeight="bold">
                              Total
                            </Text>
                            <Text as="span" fontWeight="bold">
                              £{totals.total.toFixed(2)}
                            </Text>
                          </InlineStack>


                          <Button
                            submit
                            variant="primary"
                            fullWidth
                            disabled={items.length === 0}
                          >
                            Save Quote
                          </Button>
                        </BlockStack>
                      </Card>
                    </div>
                  </Layout.Section>
                </Layout>
              </Form>
            </BlockStack>
          </Layout.Section>
        </Layout>
      </Page>
    </AppProvider>
  );
}