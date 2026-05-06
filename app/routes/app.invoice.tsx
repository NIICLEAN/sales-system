import { Form, useLoaderData, redirect } from "react-router";
import { useMemo, useState } from "react";
import {
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
  Divider,
  Badge,
  Checkbox,
  Box,
} from "@shopify/polaris";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";

const money = (value: number) => `£${Number(value || 0).toFixed(2)}`;

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
      { variables: { query: productSearch } },
    );

    const productsJson = await productsResponse.json();

    variants =
      productsJson.data?.productVariants?.edges?.map((edge: any) => edge.node) ||
      [];
  }

  if (customerSearch.trim()) {
    try {
      const customersResponse = await admin.graphql(
        `
          query Customers($query: String!) {
            customers(first: 10, query: $query) {
              edges {
                node {
                  id
                  displayName
                  email
                  phone
                  defaultAddress {
                    address1
                    address2
                    city
                    province
                    zip
                    country
                    phone
                  }
                }
              }
            }
          }
        `,
        { variables: { query: customerSearch } },
      );

      const customersJson = await customersResponse.json();

      if (customersJson.errors) {
        console.error(
          "Customer search GraphQL errors:",
          JSON.stringify(customersJson.errors, null, 2),
        );
      }

      customers =
        customersJson.data?.customers?.edges?.map((edge: any) => edge.node) ||
        [];
    } catch (error) {
      console.error("Customer search failed:", error);
      customers = [];
    }
  }

  return {
    staff,
    variants,
    productSearch,
    customers,
    customerSearch,
  };
}

export async function action({ request }: { request: Request }) {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();

  const staffId = Number(formData.get("staffId"));
  const selectedCustomerId = String(formData.get("customerId") || "").trim();

  const customerName =
    String(formData.get("customerName") || "").trim() || "Walk-in customer";
  const customerEmail = String(formData.get("customerEmail") || "").trim();
  const customerVatNumber = String(
    formData.get("customerVatNumber") || "",
  ).trim();

  let customerPhone = String(formData.get("customerPhone") || "").trim();

  if (customerPhone) {
    customerPhone = customerPhone.replace(/\s+/g, "");

    if (customerPhone.startsWith("07")) {
      customerPhone = "+44" + customerPhone.slice(1);
    }

    if (customerPhone.startsWith("08")) {
      customerPhone = "+353" + customerPhone.slice(1);
    }

    if (!customerPhone.startsWith("+")) {
      customerPhone = "";
    }
  }

  const address1 = String(formData.get("address1") || "").trim();
  const address2 = String(formData.get("address2") || "").trim();
  const city = String(formData.get("city") || "").trim();
  const county = String(formData.get("county") || "").trim();
  const postcode = String(formData.get("postcode") || "").trim();
  const country = String(formData.get("country") || "").trim();

  const reference = String(formData.get("reference") || "").trim();
  const paymentMethod = String(formData.get("paymentMethod") || "");
  const lineItems = JSON.parse(String(formData.get("lineItems") || "[]"));

  const amountPaid = Math.max(
    0,
    Number(String(formData.get("amountPaid") || "0").replace(/,/g, "")),
  );

  const depositPaid = String(formData.get("depositPaid") || "") === "on";

  let shopifyCustomerId = selectedCustomerId || null;

  if (!shopifyCustomerId && (customerEmail || customerPhone)) {
    const [firstName, ...rest] = customerName.split(" ");
    const lastName = rest.join(" ");

    const createCustomerResponse = await admin.graphql(
      `
        mutation CustomerCreate($input: CustomerInput!) {
          customerCreate(input: $input) {
            customer {
              id
            }
            userErrors {
              field
              message
            }
          }
        }
      `,
      {
        variables: {
          input: {
            firstName: firstName || customerName,
            lastName: lastName || undefined,
            email: customerEmail || undefined,
            phone: customerPhone || undefined,
            taxExempt: customerVatNumber ? true : false,
            addresses:
              address1 || city || postcode || country
                ? [
                    {
                      address1,
                      address2,
                      city,
                      province: county,
                      zip: postcode,
                      country,
                      phone: customerPhone || undefined,
                    },
                  ]
                : undefined,
          },
        },
      },
    );

    const createCustomerJson = await createCustomerResponse.json();
    const customerErrors =
      createCustomerJson.data?.customerCreate?.userErrors || [];

    if (customerErrors.length > 0) {
      throw new Response(customerErrors.map((e: any) => e.message).join(", "), {
        status: 400,
      });
    }

    shopifyCustomerId = createCustomerJson.data.customerCreate.customer.id;
  }

  const subtotal = lineItems.reduce(
    (sum: number, item: any) =>
      sum + Number(item.unitPrice) * Number(item.quantity),
    0,
  );

  const discountTotal = lineItems.reduce(
    (sum: number, item: any) => sum + Number(item.discount || 0),
    0,
  );

  const netTotal = subtotal - discountTotal;
  const vatAmount = customerVatNumber ? 0 : netTotal * 0.2;
  const total = netTotal + vatAmount;
  const balanceDue = Math.max(total - amountPaid, 0);

  const paymentStatus =
    amountPaid <= 0
      ? "Unpaid"
      : amountPaid < total
        ? "Partially Paid"
        : "Paid";

  const hasManualShippingAddress =
    address1 || address2 || city || county || postcode || country;

  const tags = [
    "Invoice App",
    paymentMethod,
    paymentStatus,
    depositPaid ? "Deposit Paid" : null,
  ].filter(Boolean) as string[];

  const draftOrderInput = {
    customerId: shopifyCustomerId || undefined,
    email: customerEmail || undefined,
    phone: customerPhone || undefined,
    taxExempt: customerVatNumber ? true : false,
    note: reference || undefined,
    tags,
    customAttributes: [
      { key: "Payment Method", value: paymentMethod },
      { key: "Payment Status", value: paymentStatus },
      { key: "Amount Paid", value: money(amountPaid) },
      { key: "Balance Due", value: money(balanceDue) },
      { key: "Deposit Paid", value: depositPaid ? "Yes" : "No" },
      { key: "Reference", value: reference || "-" },
      { key: "Salesperson ID", value: String(staffId) },
      { key: "VAT Number", value: customerVatNumber || "-" },
    ],
    shippingAddress: hasManualShippingAddress
      ? {
          firstName: customerName,
          address1,
          address2,
          city,
          province: county,
          zip: postcode,
          country,
          phone: customerPhone || undefined,
        }
      : undefined,
    lineItems: lineItems.map((item: any) => {
      const base = {
        quantity: Number(item.quantity),
        originalUnitPrice: String(Number(item.unitPrice)),
        appliedDiscount: Number(item.discount || 0)
          ? {
              value: Number(item.discount || 0),
              valueType: "FIXED_AMOUNT",
              title: "Manual discount",
            }
          : null,
      };

      if (item.type === "custom") {
        return {
          ...base,
          title: item.title || "Custom item",
          sku: item.sku || undefined,
        };
      }

      return {
        ...base,
        variantId: item.id,
      };
    }),
  };

  const createDraftResponse = await admin.graphql(
    `
      mutation CreateDraftOrder($input: DraftOrderInput!) {
        draftOrderCreate(input: $input) {
          draftOrder {
            id
            name
          }
          userErrors {
            field
            message
          }
        }
      }
    `,
    { variables: { input: draftOrderInput } },
  );

  const createDraftJson = await createDraftResponse.json();
  const createErrors = createDraftJson.data?.draftOrderCreate?.userErrors || [];

  if (createErrors.length > 0) {
    throw new Response(createErrors.map((e: any) => e.message).join(", "), {
      status: 400,
    });
  }

  const draftOrderId = createDraftJson.data.draftOrderCreate.draftOrder.id;

  const completeDraftResponse = await admin.graphql(
    `
      mutation CompleteDraftOrder($id: ID!, $paymentPending: Boolean!) {
        draftOrderComplete(id: $id, paymentPending: $paymentPending) {
          draftOrder {
            id
            order {
              id
              name
            }
          }
          userErrors {
            field
            message
          }
        }
      }
    `,
    {
      variables: {
        id: draftOrderId,
        paymentPending: paymentStatus !== "Paid",
      },
    },
  );

  const completeDraftJson = await completeDraftResponse.json();
  const completeErrors =
    completeDraftJson.data?.draftOrderComplete?.userErrors || [];

  if (completeErrors.length > 0) {
    throw new Response(completeErrors.map((e: any) => e.message).join(", "), {
      status: 400,
    });
  }

  const shopifyOrder =
    completeDraftJson.data.draftOrderComplete.draftOrder.order;

  await prisma.sale.create({
    data: {
      shopifyOrderId: shopifyOrder?.id || null,
      shopifyOrderName: shopifyOrder?.name || null,
      customerId: shopifyCustomerId,
      customerName,
      customerEmail,
      customerVatNumber,
      customerPhone,
      address1,
      address2,
      city,
      county,
      postcode,
      country,
      reference,
      paymentMethod,
      subtotal,
      discountTotal,
      vatAmount,
      total,
      amountPaid,
      balanceDue,
      paymentStatus,
      depositPaid,
      staffId,
      lineItems: {
        create: lineItems.map((item: any) => ({
          shopifyVariantId: item.type === "custom" ? null : item.id,
          title: item.title,
          sku: item.sku,
          quantity: Number(item.quantity),
          unitPrice: Number(item.unitPrice),
          discount: Number(item.discount || 0),
          lineTotal:
            Number(item.unitPrice) * Number(item.quantity) -
            Number(item.discount || 0),
          isCustom: item.type === "custom",
        })),
      },
    },
  });

  return redirect("/app/invoices?success=1");
}

export default function InvoicePage() {
  const { staff, variants, productSearch, customers, customerSearch } =
    useLoaderData<typeof loader>();

  const [searchTerm, setSearchTerm] = useState(productSearch || "");
  const [customerSearchTerm, setCustomerSearchTerm] = useState(
    customerSearch || "",
  );

  const [customerId, setCustomerId] = useState("");
  const [staffId, setStaffId] = useState(
    staff[0]?.id ? String(staff[0].id) : "",
  );

  const [customerName, setCustomerName] = useState("");
  const [customerEmail, setCustomerEmail] = useState("");
  const [customerVatNumber, setCustomerVatNumber] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");

  const [address1, setAddress1] = useState("");
  const [address2, setAddress2] = useState("");
  const [city, setCity] = useState("");
  const [county, setCounty] = useState("");
  const [postcode, setPostcode] = useState("");
  const [country, setCountry] = useState("");

  const [reference, setReference] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("Cash");
  const [items, setItems] = useState<any[]>([]);
  const [amountPaid, setAmountPaid] = useState("0");
  const [depositPaid, setDepositPaid] = useState(false);
  const [showAddress, setShowAddress] = useState(false);

  const staffOptions = staff.map((person: any) => ({
    label: person.name,
    value: String(person.id),
  }));

  const paymentOptions = [
    { label: "Cash", value: "Cash" },
    { label: "Worldpay", value: "Worldpay" },
    { label: "MyPos", value: "MyPos" },
    { label: "Bank Transfer", value: "Bank Transfer" },
  ];

  function selectCustomer(customer: any) {
    const address = customer.defaultAddress || {};

    setCustomerId(customer.id);
    setCustomerName(customer.displayName || "");
    setCustomerEmail(customer.email || "");
    setCustomerPhone(customer.phone || address.phone || "");

    setAddress1(address.address1 || "");
    setAddress2(address.address2 || "");
    setCity(address.city || "");
    setCounty(address.province || "");
    setPostcode(address.zip || "");
    setCountry(address.country || "");
  }

  function clearSelectedCustomer() {
    setCustomerId("");
    setCustomerName("");
    setCustomerEmail("");
    setCustomerVatNumber("");
    setCustomerPhone("");
    setAddress1("");
    setAddress2("");
    setCity("");
    setCounty("");
    setPostcode("");
    setCountry("");
  }

  function addItem(variant: any) {
    setItems((current) => [
      ...current,
      {
        type: "shopify",
        id: variant.id,
        title: `${variant.product.title} - ${variant.title}`,
        sku: variant.sku || "",
        quantity: 1,
        unitPrice: Number(variant.price || 0),
        discount: 0,
        imageUrl: variant.image?.url || variant.product?.featuredImage?.url || "",
      },
    ]);
  }

  function addCustomItem() {
    setItems((current) => [
      ...current,
      {
        type: "custom",
        id: `custom-${Date.now()}`,
        title: "Custom item",
        sku: "",
        quantity: 1,
        unitPrice: 0,
        discount: 0,
        imageUrl: "",
      },
    ]);
  }

  function updateItem(index: number, key: string, value: string) {
    setItems((current) =>
      current.map((item, itemIndex) =>
        itemIndex === index ? { ...item, [key]: value } : item,
      ),
    );
  }

  function removeItem(index: number) {
    setItems((current) => current.filter((_, itemIndex) => itemIndex !== index));
  }

  const totals = useMemo(() => {
    const subtotal = items.reduce(
      (sum, item) => sum + Number(item.unitPrice) * Number(item.quantity),
      0,
    );

    const discount = items.reduce(
      (sum, item) => sum + Number(item.discount || 0),
      0,
    );

    const netTotal = subtotal - discount;
    const vatAmount = customerVatNumber ? 0 : netTotal * 0.2;
    const total = netTotal + vatAmount;
    const paid = Math.max(0, Number(amountPaid || 0));
    const balanceDue = Math.max(total - paid, 0);

    const paymentStatus =
      paid <= 0 ? "Unpaid" : paid < total ? "Partially Paid" : "Paid";

    return {
      subtotal,
      discount,
      vatAmount,
      total,
      paid,
      balanceDue,
      paymentStatus,
    };
  }, [items, customerVatNumber, amountPaid]);

  return (
    <Page
      title="Create Invoice"
      subtitle="Search products on the left, build the invoice on the right."
    >
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
                        name="customerSearch"
                        value={customerSearchTerm}
                        onChange={setCustomerSearchTerm}
                        autoComplete="off"
                        placeholder="Search by customer name, email, or phone"
                      />
                    </div>

                    <input
                      type="hidden"
                      name="productSearch"
                      value={searchTerm}
                    />

                    <Button submit>Search Customer</Button>
                  </InlineStack>
                </BlockStack>
              </Form>

              {customerSearch && (
                <div style={{ marginTop: 16 }}>
                  <IndexTable
                    resourceName={{
                      singular: "customer",
                      plural: "customers",
                    }}
                    itemCount={customers.length}
                    headings={[
                      { title: "Customer" },
                      { title: "Email" },
                      { title: "Action" },
                    ]}
                    selectable={false}
                  >
                    {customers.map((customer: any, index: number) => (
                      <IndexTable.Row
                        id={customer.id}
                        key={customer.id}
                        position={index}
                      >
                        <IndexTable.Cell>
                          {customer.displayName}
                        </IndexTable.Cell>
                        <IndexTable.Cell>
                          {customer.email || "-"}
                        </IndexTable.Cell>
                        <IndexTable.Cell>
                          <Button onClick={() => selectCustomer(customer)}>
                            Use customer
                          </Button>
                        </IndexTable.Cell>
                      </IndexTable.Row>
                    ))}
                  </IndexTable>

                  {customers.length === 0 && (
                    <div style={{ marginTop: 12 }}>
                      <Text as="p" tone="subdued">
                        No customers found. Enter customer details below to
                        create a new customer.
                      </Text>
                    </div>
                  )}
                </div>
              )}
            </Card>

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
                        name="productSearch"
                        value={searchTerm}
                        onChange={setSearchTerm}
                        autoComplete="off"
                        placeholder="Search by product name or SKU"
                      />
                    </div>

                    <input
                      type="hidden"
                      name="customerSearch"
                      value={customerSearchTerm}
                    />

                    <Button submit>Search Product</Button>
                  </InlineStack>
                </BlockStack>
              </Form>
            </Card>

            {productSearch && (
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    Product search results
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
                    {variants.map((variant: any, index: number) => {
                      const imageUrl =
                        variant.image?.url || variant.product?.featuredImage?.url;

                      const imageAlt =
                        variant.image?.altText ||
                        variant.product?.featuredImage?.altText ||
                        variant.product?.title ||
                        "Product image";

                      return (
                        <IndexTable.Row
                          id={variant.id}
                          key={variant.id}
                          position={index}
                        >
                          <IndexTable.Cell>
                            {imageUrl ? (
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
                            )}
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
                      );
                    })}
                  </IndexTable>

                  {variants.length === 0 && (
                    <Text as="p" tone="subdued">
                      No products found.
                    </Text>
                  )}
                </BlockStack>
              </Card>
            )}
          </BlockStack>
        </Layout.Section>

        <Layout.Section variant="oneThird">
          <div style={{ position: "sticky", top: 16 }}>
            <Card>
              <BlockStack gap="400">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    Invoice lines
                  </Text>

                  <Button onClick={addCustomItem}>Add custom item</Button>
                </InlineStack>

                <Divider />

                {items.length === 0 ? (
                  <Box paddingBlock="400">
                    <Text as="p" tone="subdued">
                      No items added yet.
                    </Text>
                  </Box>
                ) : (
                  <BlockStack gap="300">
                    {items.map((item, index) => (
                      <Card key={item.id || index}>
                        <BlockStack gap="300">
                          <InlineStack align="space-between" blockAlign="start">
                            <InlineStack gap="200" blockAlign="center">
                              {item.imageUrl && (
                                <img
                                  src={item.imageUrl}
                                  alt={item.title}
                                  style={{
                                    width: 42,
                                    height: 42,
                                    objectFit: "cover",
                                    borderRadius: 8,
                                    border: "1px solid #ddd",
                                  }}
                                />
                              )}

                              <div style={{ maxWidth: 210 }}>
                                <Text as="p" fontWeight="bold">
                                  {item.title}
                                </Text>
                                {item.sku && (
                                  <Text as="p" tone="subdued">
                                    SKU: {item.sku}
                                  </Text>
                                )}
                              </div>
                            </InlineStack>

                            <Button
                              tone="critical"
                              onClick={(event) => {
                                event.preventDefault();
                                removeItem(index);
                              }}
                            >
                              Remove
                            </Button>
                          </InlineStack>

                          {item.type === "custom" && (
                            <BlockStack gap="300">
                              <TextField
                                label="Item name"
                                value={String(item.title)}
                                onChange={(value) =>
                                  updateItem(index, "title", value)
                                }
                                autoComplete="off"
                              />

                              <TextField
                                label="SKU"
                                value={String(item.sku)}
                                onChange={(value) =>
                                  updateItem(index, "sku", value)
                                }
                                autoComplete="off"
                              />
                            </BlockStack>
                          )}

                          <InlineStack gap="200">
                            <div style={{ width: 75 }}>
                              <TextField
                                label="Qty"
                                value={String(item.quantity)}
                                onChange={(value) =>
                                  updateItem(index, "quantity", value)
                                }
                                autoComplete="off"
                                type="number"
                              />
                            </div>

                            <div style={{ width: 115 }}>
                              <TextField
                                label="Price"
                                value={String(item.unitPrice)}
                                onChange={(value) =>
                                  updateItem(index, "unitPrice", value)
                                }
                                autoComplete="off"
                                type="number"
                                prefix="£"
                              />
                            </div>

                            <div style={{ width: 115 }}>
                              <TextField
                                label="Discount"
                                value={String(item.discount)}
                                onChange={(value) =>
                                  updateItem(index, "discount", value)
                                }
                                autoComplete="off"
                                type="number"
                                prefix="£"
                              />
                            </div>
                          </InlineStack>

                          <Text as="p" fontWeight="bold">
                            Line total:{" "}
                            {money(
                              Number(item.unitPrice) * Number(item.quantity) -
                                Number(item.discount || 0),
                            )}
                          </Text>
                        </BlockStack>
                      </Card>
                    ))}
                  </BlockStack>
                )}
              </BlockStack>
            </Card>
          </div>
        </Layout.Section>
      </Layout>

      <div style={{ marginTop: 16 }}>
        <Form method="post">
          <input type="hidden" name="lineItems" value={JSON.stringify(items)} />
          <input type="hidden" name="customerId" value={customerId} />

          <Layout>
            <Layout.Section>
              <BlockStack gap="400">
                <Card>
                  <BlockStack gap="400">
                    <InlineStack align="space-between" blockAlign="center">
                      <Text as="h2" variant="headingMd">
                        Customer details
                      </Text>

                      {customerId && (
                        <Button
                          onClick={(event) => {
                            event.preventDefault();
                            clearSelectedCustomer();
                          }}
                        >
                          Clear selected customer
                        </Button>
                      )}
                    </InlineStack>

                    {customerId && (
                      <Text as="p" tone="success">
                        Existing Shopify customer selected.
                      </Text>
                    )}

                    {!customerId && (
                      <Text as="p" tone="subdued">
                        If no existing customer is selected, a new Shopify
                        customer will be created when email or phone is provided.
                      </Text>
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

                    <InlineStack gap="300">
                      <div style={{ flex: 1 }}>
                        <TextField
                          label="Customer phone"
                          name="customerPhone"
                          value={customerPhone}
                          onChange={setCustomerPhone}
                          autoComplete="off"
                        />
                      </div>

                      <div style={{ flex: 1 }}>
                        <TextField
                          label="VAT number"
                          name="customerVatNumber"
                          value={customerVatNumber}
                          onChange={setCustomerVatNumber}
                          autoComplete="off"
                          placeholder="Leave blank to charge 20% VAT"
                        />
                      </div>
                    </InlineStack>

                    <Button
                      onClick={(event) => {
                        event.preventDefault();
                        setShowAddress((open) => !open);
                      }}
                    >
                      {showAddress ? "Hide address" : "Edit shipping address"}
                    </Button>

                    {showAddress && (
                      <BlockStack gap="300">
                        <InlineStack gap="300">
                          <div style={{ flex: 1 }}>
                            <TextField
                              label="Address line 1"
                              name="address1"
                              value={address1}
                              onChange={setAddress1}
                              autoComplete="off"
                            />
                          </div>

                          <div style={{ flex: 1 }}>
                            <TextField
                              label="Address line 2"
                              name="address2"
                              value={address2}
                              onChange={setAddress2}
                              autoComplete="off"
                            />
                          </div>
                        </InlineStack>

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
                              placeholder="United Kingdom"
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
                      Invoice details
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
                          label="Payment method"
                          name="paymentMethod"
                          options={paymentOptions}
                          value={paymentMethod}
                          onChange={setPaymentMethod}
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
              <div style={{ position: "sticky", top: 16 }}>
                <Card>
                  <BlockStack gap="400">
                    <InlineStack align="space-between" blockAlign="center">
                      <Text as="h2" variant="headingMd">
                        Summary
                      </Text>

                      <Badge
                        tone={
                          totals.paymentStatus === "Paid"
                            ? "success"
                            : totals.paymentStatus === "Partially Paid"
                              ? "attention"
                              : "critical"
                        }
                      >
                        {totals.paymentStatus}
                      </Badge>
                    </InlineStack>

                    <BlockStack gap="200">
                      <InlineStack align="space-between">
                        <Text as="p">Subtotal</Text>
                        <Text as="p">{money(totals.subtotal)}</Text>
                      </InlineStack>

                      <InlineStack align="space-between">
                        <Text as="p">Discount</Text>
                        <Text as="p">{money(totals.discount)}</Text>
                      </InlineStack>

                      <InlineStack align="space-between">
                        <Text as="p">VAT</Text>
                        <Text as="p">{money(totals.vatAmount)}</Text>
                      </InlineStack>

                      <Divider />

                      <InlineStack align="space-between">
                        <Text as="p" fontWeight="bold">
                          Total
                        </Text>
                        <Text as="p" fontWeight="bold">
                          {money(totals.total)}
                        </Text>
                      </InlineStack>
                    </BlockStack>

                    <Divider />

                    <BlockStack gap="300">
                      <TextField
                        label="Amount paid"
                        name="amountPaid"
                        value={amountPaid}
                        onChange={setAmountPaid}
                        autoComplete="off"
                        type="number"
                        prefix="£"
                      />

                      <Checkbox
                        label="Deposit paid"
                        name="depositPaid"
                        checked={depositPaid}
                        onChange={setDepositPaid}
                      />

                      {depositPaid && <Badge tone="success">Deposit Paid</Badge>}
                    </BlockStack>

                    <Divider />

                    <InlineStack align="space-between">
                      <Text as="p" fontWeight="bold">
                        Balance due
                      </Text>
                      <Text as="p" fontWeight="bold">
                        {money(totals.balanceDue)}
                      </Text>
                    </InlineStack>

                    <Button submit variant="primary" fullWidth>
                      Save Invoice
                    </Button>
                  </BlockStack>
                </Card>
              </div>
            </Layout.Section>
          </Layout>
        </Form>
      </div>
    </Page>
  );
}