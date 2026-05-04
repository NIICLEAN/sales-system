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
} from "@shopify/polaris";

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
      { variables: { query: productSearch } },
    );

    const productsJson = await productsResponse.json();

    variants =
      productsJson.data?.productVariants?.edges?.map((edge: any) => edge.node) ||
      [];
  }

  if (customerSearch.trim()) {
    const customersResponse = await admin.graphql(
      `
        query Customers($query: String!) {
          customers(first: 10, query: $query) {
            edges {
              node {
                id
                displayName
                firstName
                lastName
                taxExempt
                defaultEmailAddress {
                  emailAddress
                }
                defaultPhoneNumber {
                  phoneNumber
                }
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

    customers =
      customersJson.data?.customers?.edges?.map((edge: any) => edge.node) || [];
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
            addresses: [
              {
                address1,
                address2,
                city,
                province: county,
                zip: postcode,
                country,
                phone: customerPhone || undefined,
              },
            ],
          },
        },
      },
    );

    const createCustomerJson = await createCustomerResponse.json();
    const customerErrors = createCustomerJson.data.customerCreate.userErrors;

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

  const draftOrderInput = {
    customerId: shopifyCustomerId || undefined,
    email: customerEmail || undefined,
    phone: customerPhone || undefined,
    taxExempt: customerVatNumber ? true : false,
    note: reference || undefined,
    tags: ["Invoice App", paymentMethod],
    customAttributes: [
      { key: "Payment Method", value: paymentMethod },
      { key: "Reference", value: reference || "-" },
      { key: "Salesperson ID", value: String(staffId) },
      { key: "VAT Number", value: customerVatNumber || "-" },
    ],
    shippingAddress: {
      firstName: customerName,
      address1,
      address2,
      city,
      province: county,
      zip: postcode,
      country,
      phone: customerPhone || undefined,
    },
    lineItems: lineItems.map((item: any) => ({
      variantId: item.id,
      quantity: Number(item.quantity),
      originalUnitPrice: String(Number(item.unitPrice)),
      appliedDiscount: Number(item.discount || 0)
        ? {
            value: Number(item.discount || 0),
            valueType: "FIXED_AMOUNT",
            title: "Manual discount",
          }
        : null,
    })),
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
  const createErrors = createDraftJson.data.draftOrderCreate.userErrors;

  if (createErrors.length > 0) {
    throw new Response(createErrors.map((e: any) => e.message).join(", "), {
      status: 400,
    });
  }

  const draftOrderId = createDraftJson.data.draftOrderCreate.draftOrder.id;

  const completeDraftResponse = await admin.graphql(
    `
      mutation CompleteDraftOrder($id: ID!) {
        draftOrderComplete(id: $id, paymentPending: false) {
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
    { variables: { id: draftOrderId } },
  );

  const completeDraftJson = await completeDraftResponse.json();
  const completeErrors = completeDraftJson.data.draftOrderComplete.userErrors;

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
  const [country, setCountry] = useState("United Kingdom");

  const [reference, setReference] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("Cash");
  const [items, setItems] = useState<any[]>([]);

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
    const address = customer.defaultAddress;

    setCustomerId(customer.id);
    setCustomerName(customer.displayName || "");
    setCustomerEmail(customer.defaultEmailAddress?.emailAddress || "");
    setCustomerPhone(
      customer.defaultPhoneNumber?.phoneNumber || address?.phone || "",
    );

    setAddress1(address?.address1 || "");
    setAddress2(address?.address2 || "");
    setCity(address?.city || "");
    setCounty(address?.province || "");
    setPostcode(address?.zip || "");
    setCountry(address?.country || "United Kingdom");
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
    setCountry("United Kingdom");
  }

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

    return {
      subtotal,
      discount,
      vatAmount,
      total: netTotal + vatAmount,
    };
  }, [items, customerVatNumber]);

  return (
    <Page title="Create Invoice">
      <Layout>
        <Layout.Section>
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
                      placeholder="Search by name, email, or phone"
                    />
                  </div>

                  <input type="hidden" name="productSearch" value={searchTerm} />

                  <Button submit>Search Customer</Button>
                </InlineStack>
              </BlockStack>
            </Form>

            {customerSearch && (
              <div style={{ marginTop: "16px" }}>
                <IndexTable
                  resourceName={{ singular: "customer", plural: "customers" }}
                  itemCount={customers.length}
                  headings={[
                    { title: "Customer" },
                    { title: "Email" },
                    { title: "Phone" },
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
                      <IndexTable.Cell>{customer.displayName}</IndexTable.Cell>
                      <IndexTable.Cell>
                        {customer.defaultEmailAddress?.emailAddress || "-"}
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        {customer.defaultPhoneNumber?.phoneNumber || "-"}
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <Button onClick={() => selectCustomer(customer)}>
                          Use customer
                        </Button>
                      </IndexTable.Cell>
                    </IndexTable.Row>
                  ))}
                </IndexTable>
              </div>
            )}
          </Card>
        </Layout.Section>

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

                <input
                  type="hidden"
                  name="customerSearch"
                  value={customerSearchTerm}
                />

                <Button submit>Search Product</Button>
              </InlineStack>
            </Form>
          </Card>
        </Layout.Section>

        {productSearch && (
          <Layout.Section>
            <Card>
              <Text as="h2" variant="headingMd">
                Product search results
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
            </Card>
          </Layout.Section>
        )}

        <Layout.Section>
          <Card>
            <Form method="post">
              <input type="hidden" name="lineItems" value={JSON.stringify(items)} />
              <input type="hidden" name="customerId" value={customerId} />

              <BlockStack gap="400">
                <Select
                  label="Account / Salesperson"
                  name="staffId"
                  options={staffOptions}
                  value={staffId}
                  onChange={setStaffId}
                />

                <InlineStack gap="300" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    Customer details
                  </Text>

                  {customerId && (
                    <Button onClick={clearSelectedCustomer}>
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
                    If no existing customer is selected, a new Shopify customer
                    will be created using these details.
                  </Text>
                )}

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
                  label="VAT number"
                  name="customerVatNumber"
                  value={customerVatNumber}
                  onChange={setCustomerVatNumber}
                  autoComplete="off"
                  placeholder="Leave blank to charge 20% VAT"
                />

                <TextField
                  label="Customer phone"
                  name="customerPhone"
                  value={customerPhone}
                  onChange={setCustomerPhone}
                  autoComplete="off"
                />

                <Text as="h2" variant="headingMd">
                  Shipping address
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

                <Select
                  label="Payment method"
                  name="paymentMethod"
                  options={paymentOptions}
                  value={paymentMethod}
                  onChange={setPaymentMethod}
                />

                <Text as="h2" variant="headingMd">
                  Invoice lines
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
                  Save Invoice
                </Button>
              </BlockStack>
            </Form>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}