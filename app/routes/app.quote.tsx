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
} from "@shopify/polaris";
import "@shopify/polaris/build/esm/styles.css";

import { unauthenticated } from "../shopify.server";
import prisma from "../db.server";

export async function loader({ request }: { request: Request }) {

const { admin } = await unauthenticated.admin("j0tccd-cm.myshopify.com");
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
      productsJson.data.productVariants.edges.map((edge: any) => edge.node) || [];
  }

  return {
    staff,
    variants,
    productSearch,
  };
}

export async function action({ request }: { request: Request }) {
const { admin } = await unauthenticated.admin("j0tccd-cm.myshopify.com");

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

  await prisma.quote.create({
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

  return redirect("/app/quotes");
}

export default function QuotePage() {
  const { staff, variants, productSearch } = useLoaderData<typeof loader>();

  const [searchTerm, setSearchTerm] = useState(productSearch || "");
  const [staffId, setStaffId] = useState(staff[0]?.id ? String(staff[0].id) : "");

  const [customerName, setCustomerName] = useState("");
  const [customerEmail, setCustomerEmail] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");

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
      vatAmount,
      total: netTotal + vatAmount,
    };
  }, [items]);

  return (
    <AppProvider i18n={{}}>
      <Page title="Create Quote">
        <Layout>
          <Layout.Section>
            <Card>
              <Form method="get">
                <InlineStack gap="300" blockAlign="end">
                  <div style={{ flex: 1 }}>
                    <TextField
                      label="Search products"
                      name="productSearch"
                      value={searchTerm}
                      onChange={setSearchTerm}
                      autoComplete="off"
                      placeholder="Search by product name or SKU"
                    />
                  </div>

                  <Button submit>Search</Button>
                </InlineStack>
              </Form>
            </Card>
          </Layout.Section>

          {productSearch && (
            <Layout.Section>
              <Card>
                <Text as="h2" variant="headingMd">
                  Search results
                </Text>

                <IndexTable
                  resourceName={{ singular: "product", plural: "products" }}
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
                    <IndexTable.Row id={variant.id} key={variant.id} position={index}>
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
              </Card>
            </Layout.Section>
          )}

          <Layout.Section>
            <Card>
              <Form method="post">
                <input type="hidden" name="lineItems" value={JSON.stringify(items)} />

                <BlockStack gap="400">
                  <Select
                    label="Account / Salesperson"
                    name="staffId"
                    options={staffOptions}
                    value={staffId}
                    onChange={setStaffId}
                  />

                  <Text as="h2" variant="headingMd">
                    Customer details
                  </Text>

                  <TextField
                    label="Customer name"
                    name="customerName"
                    value={customerName}
                    onChange={setCustomerName}
                    autoComplete="off"
                  />

                  <TextField
                    label="Customer email"
                    name="customerEmail"
                    value={customerEmail}
                    onChange={setCustomerEmail}
                    autoComplete="off"
                  />

                  <TextField
                    label="Customer phone"
                    name="customerPhone"
                    value={customerPhone}
                    onChange={setCustomerPhone}
                    autoComplete="off"
                  />

                  <Text as="h2" variant="headingMd">
                    Address
                  </Text>

                  <TextField label="Address line 1" name="address1" value={address1} onChange={setAddress1} autoComplete="off" />
                  <TextField label="Address line 2" name="address2" value={address2} onChange={setAddress2} autoComplete="off" />
                  <TextField label="Town / City" name="city" value={city} onChange={setCity} autoComplete="off" />
                  <TextField label="County" name="county" value={county} onChange={setCounty} autoComplete="off" />
                  <TextField label="Postcode" name="postcode" value={postcode} onChange={setPostcode} autoComplete="off" />
                  <TextField label="Country" name="country" value={country} onChange={setCountry} autoComplete="off" />

                  <TextField
                    label="Reference"
                    name="reference"
                    value={reference}
                    onChange={setReference}
                    autoComplete="off"
                    placeholder="Customer PO, job ref, or note"
                  />

                  <Text as="h2" variant="headingMd">
                    Quote lines
                  </Text>

                  {items.map((item, index) => (
                    <Card key={index}>
                      <BlockStack gap="300">
                        <Text as="p" fontWeight="bold">
                          {item.title}
                        </Text>

                        <InlineStack gap="300">
                          <div style={{ width: "120px" }}>
                            <TextField
                              label="Qty"
                              value={String(item.quantity)}
                              onChange={(value) => updateItem(index, "quantity", value)}
                              autoComplete="off"
                              type="number"
                            />
                          </div>

                          <div style={{ width: "160px" }}>
                            <TextField
                              label="Unit price"
                              value={String(item.unitPrice)}
                              onChange={(value) => updateItem(index, "unitPrice", value)}
                              autoComplete="off"
                              type="number"
                              prefix="£"
                            />
                          </div>

                          <div style={{ width: "160px" }}>
                            <TextField
                              label="Discount"
                              value={String(item.discount)}
                              onChange={(value) => updateItem(index, "discount", value)}
                              autoComplete="off"
                              type="number"
                              prefix="£"
                            />
                          </div>

                          <div style={{ paddingTop: "28px" }}>
                            <Button tone="critical" onClick={() => removeItem(index)}>
                              Remove
                            </Button>
                          </div>
                        </InlineStack>
                      </BlockStack>
                    </Card>
                  ))}

                  <Text as="p">Subtotal: £{totals.subtotal.toFixed(2)}</Text>
                  <Text as="p">Discount: £{totals.discount.toFixed(2)}</Text>
                  <Text as="p">VAT: £{totals.vatAmount.toFixed(2)}</Text>
                  <Text as="p" fontWeight="bold">
                    Total: £{totals.total.toFixed(2)}
                  </Text>

                  <Button submit variant="primary">
                    Save Quote
                  </Button>
                </BlockStack>
              </Form>
            </Card>
          </Layout.Section>
        </Layout>
      </Page>
    </AppProvider>
  );
}