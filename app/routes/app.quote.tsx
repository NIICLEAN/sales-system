import { Form, useLoaderData, redirect } from "react-router";
import { useMemo, useRef, useState } from "react";
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
} from "@shopify/polaris";
import "@shopify/polaris/build/esm/styles.css";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export async function loader({ request }: { request: Request }) {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);

  const productSearch = url.searchParams.get("productSearch") || "";
  const customerSearch = url.searchParams.get("customerSearch") || "";

  const staff = await prisma.staff.findMany({
    orderBy: { name: "asc" },
  });

  let variants: any[] = [];
  let customers: any[] = [];

  if (productSearch.trim()) {
    try {
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
                  image {
                    url
                    altText
                  }
                  product {
                    title
                    featuredImage {
                      url
                      altText
                    }
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

      const productsJson = (await productsResponse.json()) as any;

      if (productsJson.errors) {
        console.error(
          "Product search GraphQL errors:",
          JSON.stringify(productsJson.errors, null, 2),
        );
      }

      variants =
        productsJson.data?.productVariants?.edges?.map((edge: any) => edge.node) ||
        [];
    } catch (error) {
      console.error("Product search failed:", error);
      variants = [];
    }
  }

  if (customerSearch.trim()) {
    try {
      const customersResponse = await admin.graphql(
        `
          query Customers($query: String) {
            customers(first: 10, query: $query) {
              edges {
                node {
                  id
                  firstName
                  lastName
                  email
                  phone
                  defaultAddress {
                    address1
                    address2
                    city
                    province
                    zip
                    country
                  }
                }
              }
            }
          }
        `,
        {
          variables: {
            query: customerSearch,
          },
        }
      );

      const customersJson = (await customersResponse.json()) as any;

      if (customersJson.errors) {
        console.error(
          "Customer search GraphQL errors:",
          JSON.stringify(customersJson.errors, null, 2),
        );
      }

      customers =
        customersJson.data?.customers?.edges?.map((edge: any) => edge.node) || [];
    } catch (error) {
      console.error("Customer search failed:", error);
      customers = [];
    }
  }

  return {
    staff,
    variants,
    customers,
    productSearch,
    customerSearch,
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
  const vatType = String(formData.get("vatType") || "Standard");
  const vatAmount = vatType === "Exempt" || vatType === "CrossBorder" ? 0 : netTotal * 0.2;
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
      vatType: vatType as any,
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
  const { staff, variants, customers, productSearch, customerSearch } =
    useLoaderData<typeof loader>();

  const [productSearchTerm, setProductSearchTerm] = useState(productSearch || "");
  const [customerSearchTerm, setCustomerSearchTerm] = useState(customerSearch || "");

  const [staffId, setStaffId] = useState(
    staff[0]?.id ? String(staff[0].id) : ""
  );

  const [customerName, setCustomerName] = useState("");
  const [customerEmail, setCustomerEmail] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [customerVatNumber, setCustomerVatNumber] = useState("");
  const [selectedCustomer, setSelectedCustomer] = useState<{
    id: string;
    name: string;
    email: string;
    phone: string;
  } | null>(null);

  const [addressOpen, setAddressOpen] = useState(false);
  const [address1, setAddress1] = useState("");
  const [address2, setAddress2] = useState("");
  const [city, setCity] = useState("");
  const [county, setCounty] = useState("");
  const [postcode, setPostcode] = useState("");
  const [country, setCountry] = useState("United Kingdom");

  const [reference, setReference] = useState("");
  const [items, setItems] = useState<any[]>([]);
  const productSearchRef = useRef<HTMLDivElement | null>(null);

  const staffOptions = staff.map((person: any) => ({
    label: person.name,
    value: String(person.id),
  }));

  function selectCustomer(customer: any) {
    const fullName = [customer.firstName, customer.lastName]
      .filter(Boolean)
      .join(" ");

    const selectedName = fullName || "Unnamed customer";

    setCustomerName(fullName || "");
    setCustomerEmail(customer.email || "");
    setCustomerPhone(customer.phone || "");
    setSelectedCustomer({
      id: String(customer.id || ""),
      name: selectedName,
      email: customer.email || "",
      phone: customer.phone || "",
    });

    const address = customer.defaultAddress;

    if (address) {
      setAddress1(address.address1 || "");
      setAddress2(address.address2 || "");
      setCity(address.city || "");
      setCounty(address.province || "");
      setPostcode(address.zip || "");
      setCountry(address.country || "United Kingdom");
    }

    // Move the user directly to product selection after picking a customer.
    window.setTimeout(() => {
      productSearchRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    }, 0);
  }

  function clearSelectedCustomer() {
    setSelectedCustomer(null);
  }

  function addItem(variant: any) {
    setItems((current) => [
      ...current,
      {
        id: variant.id,
        title: `${variant.product.title} - ${variant.title}`,
        sku: variant.sku || "",
        imageUrl:
          variant.image?.url || variant.product?.featuredImage?.url || "",
        quantity: 1,
        unitPrice: Number(variant.price || 0),
        discount: 0,
      },
    ]);
  }

  function addCustomItem() {
    setItems((current) => [
      ...current,
      {
        id: `custom-${Date.now()}`,
        title: "Custom item",
        sku: "",
        quantity: 1,
        unitPrice: 0,
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
                      Find existing customer
                    </Text>

                    <InlineStack gap="300" blockAlign="end">
                      <div style={{ flex: 1 }}>
                        <TextField
                          label="Search customers"
                          labelHidden
                          name="customerSearch"
                          value={customerSearchTerm}
                          onChange={setCustomerSearchTerm}
                          autoComplete="off"
                          placeholder="Search by customer name, email, or phone"
                        />
                      </div>

                      <Button submit>Search Customer</Button>
                    </InlineStack>
                  </BlockStack>
                </Form>
              </Card>

              {customerSearch && customers.length > 0 && (
                <Card>
                  <BlockStack gap="300">
                    <Text as="h2" variant="headingMd">
                      Customer results
                    </Text>

                    <IndexTable
                      resourceName={{
                        singular: "customer",
                        plural: "customers",
                      }}
                      itemCount={customers.length}
                      headings={[
                        { title: "Customer" },
                        { title: "Email" },
                        { title: "Phone" },
                        { title: "Action" },
                      ]}
                      selectable={false}
                    >
                      {customers.map((customer: any, index: number) => {
                        const fullName = [customer.firstName, customer.lastName]
                          .filter(Boolean)
                          .join(" ");

                        return (
                          <IndexTable.Row
                            id={customer.id}
                            key={customer.id}
                            position={index}
                          >
                            <IndexTable.Cell>
                              {fullName || "Unnamed customer"}
                            </IndexTable.Cell>
                            <IndexTable.Cell>{customer.email || "-"}</IndexTable.Cell>
                            <IndexTable.Cell>{customer.phone || "-"}</IndexTable.Cell>
                            <IndexTable.Cell>
                              <Button onClick={() => selectCustomer(customer)}>
                                Select
                              </Button>
                            </IndexTable.Cell>
                          </IndexTable.Row>
                        );
                      })}
                    </IndexTable>
                  </BlockStack>
                </Card>
              )}

              <Card>
                <div ref={productSearchRef} />
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
                          value={productSearchTerm}
                          onChange={setProductSearchTerm}
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
                        { title: "Image" },
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
                            {(() => {
                              const imageUrl =
                                variant.image?.url ||
                                variant.product?.featuredImage?.url;
                              const imageAlt =
                                variant.image?.altText ||
                                variant.product?.featuredImage?.altText ||
                                variant.product?.title ||
                                "Product image";

                              return imageUrl ? (
                                <img
                                  src={imageUrl}
                                  alt={imageAlt}
                                  style={{
                                    width: 56,
                                    height: 56,
                                    objectFit: "cover",
                                    borderRadius: 8,
                                    border: "1px solid #ddd",
                                  }}
                                />
                              ) : (
                                <div
                                  style={{
                                    width: 56,
                                    height: 56,
                                    borderRadius: 8,
                                    border: "1px solid #ddd",
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    fontSize: 11,
                                    color: "#777",
                                    textAlign: "center",
                                  }}
                                >
                                  No image
                                </div>
                              );
                            })()}
                          </IndexTable.Cell>

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

                    <Button onClick={addCustomItem}>Add custom item</Button>
                  </InlineStack>

                  <Divider />

                  {items.length === 0 ? (
                    <Text as="p" tone="subdued">
                      No items added yet. Search for a Shopify product above or
                      add a custom item.
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
                            <IndexTable.Cell>
                              <TextField
                                label="Product"
                                labelHidden
                                value={item.title}
                                onChange={(value) =>
                                  updateItem(index, "title", value)
                                }
                                autoComplete="off"
                              />
                            </IndexTable.Cell>

                            <IndexTable.Cell>
                              <div style={{ width: 100 }}>
                                <TextField
                                  label="SKU"
                                  labelHidden
                                  value={item.sku}
                                  onChange={(value) =>
                                    updateItem(index, "sku", value)
                                  }
                                  autoComplete="off"
                                />
                              </div>
                            </IndexTable.Cell>

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

                            <IndexTable.Cell>£{Number(lineTotal ?? 0).toFixed(2)}</IndexTable.Cell>

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

                          {selectedCustomer && (
                            <div
                              style={{
                                padding: 12,
                                border: "1px solid #8c9196",
                                borderRadius: 8,
                                background: "#f6f6f7",
                              }}
                            >
                              <InlineStack align="space-between" blockAlign="center">
                                <BlockStack gap="100">
                                  <InlineStack gap="200" blockAlign="center">
                                    <Badge tone="success">Selected customer</Badge>
                                    <Text as="span" tone="subdued">
                                      {selectedCustomer.id}
                                    </Text>
                                  </InlineStack>

                                  <Text as="p" fontWeight="bold">
                                    {selectedCustomer.name}
                                  </Text>

                                  <Text as="p" tone="subdued">
                                    {selectedCustomer.email || "No email"}
                                    {" • "}
                                    {selectedCustomer.phone || "No phone"}
                                  </Text>
                                </BlockStack>

                                <Button variant="plain" onClick={clearSelectedCustomer}>
                                  Clear selection
                                </Button>
                              </InlineStack>
                            </div>
                          )}

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
                            {addressOpen
                              ? "Hide shipping address"
                              : "Edit shipping address"}
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
                                <TextField
                                  label="VAT number"
                                  name="customerVatNumber"
                                  value={customerVatNumber}
                                  onChange={setCustomerVatNumber}
                                  autoComplete="off"
                                />

                                <Select
                                  label="VAT type"
                                  options={[
                                    { label: "Standard 20%", value: "Standard" },
                                    { label: "VAT exempt", value: "Exempt" },
                                    { label: "Cross-border", value: "CrossBorder" },
                                  ]}
                                  onChange={() => {}}
                                  value={"Standard"}
                                />

                                <input type="hidden" name="vatType" value={"Standard"} />
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
                              <Text as="span">£{Number(totals.subtotal ?? 0).toFixed(2)}</Text>
                            </InlineStack>

                            <InlineStack align="space-between">
                              <Text as="span">Discount</Text>
                              <Text as="span">£{Number(totals.discount ?? 0).toFixed(2)}</Text>
                            </InlineStack>

                            <InlineStack align="space-between">
                              <Text as="span">Net total</Text>
                              <Text as="span">£{Number(totals.netTotal ?? 0).toFixed(2)}</Text>
                            </InlineStack>

                            <InlineStack align="space-between">
                              <Text as="span">VAT</Text>
                              <Text as="span">£{Number(totals.vatAmount ?? 0).toFixed(2)}</Text>
                            </InlineStack>
                          </BlockStack>

                          <Divider />

                          <InlineStack align="space-between">
                            <Text as="span" fontWeight="bold">
                              Total
                            </Text>
                            <Text as="span" fontWeight="bold">
                              £{Number(totals.total ?? 0).toFixed(2)}
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