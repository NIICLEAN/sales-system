import { Form, useLoaderData } from "react-router";
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
      },
    );

    const productsJson = await productsResponse.json();

    variants =
      productsJson.data?.productVariants?.edges?.map(
        (edge: any) => edge.node,
      ) || [];
  }

  return {
    staff,
    variants,
    productSearch,
  };
}

function safeNumber(value: any) {
  const number = Number(value);

  if (Number.isNaN(number)) {
    return 0;
  }

  return number;
}

export async function action({ request }: { request: Request }) {
const { redirect } = await authenticate.admin(request);

  const formData = await request.formData();

  const salespersonId = Number(formData.get("salespersonId"));

  const customerName =
    String(formData.get("customerName") || "").trim() || "Walk-in customer";

  const customerEmail = String(formData.get("customerEmail") || "").trim();
  const customerPhone = String(formData.get("customerPhone") || "").trim();
  const customerVatNumber = String(
    formData.get("customerVatNumber") || "",
  ).trim();

  const address1 = String(formData.get("address1") || "").trim();
  const address2 = String(formData.get("address2") || "").trim();
  const city = String(formData.get("city") || "").trim();
  const county = String(formData.get("county") || "").trim();
  const postcode = String(formData.get("postcode") || "").trim();
  const country = String(formData.get("country") || "").trim();

  const serviceType = String(formData.get("serviceType") || "").trim();
  const extraInfo = String(formData.get("extraInfo") || "").trim();

  const paymentMethod = String(formData.get("paymentMethod") || "Cash");
  const paymentStatus = String(formData.get("paymentStatus") || "unpaid");
  const amountPaid = Number(formData.get("amountPaid") || 0);

  const lineItems = JSON.parse(String(formData.get("lineItems") || "[]"));

  if (!salespersonId) {
    throw new Response("Please choose a salesperson.", { status: 400 });
  }

  if (!serviceType) {
    throw new Response("Please choose a service type.", { status: 400 });
  }

  if (lineItems.length === 0) {
    throw new Response("Please add at least one product or custom line.", {
      status: 400,
    });
  }

 const subtotal = lineItems.reduce(
  (sum: number, item: any) =>
    sum + safeNumber(item.unitPrice) * safeNumber(item.quantity),
  0,
);

const discountTotal = lineItems.reduce(
  (sum: number, item: any) => sum + safeNumber(item.discount),
  0,
);

const netTotal = subtotal - discountTotal;
const vatAmount = customerVatNumber ? 0 : netTotal * 0.2;
const total = netTotal + vatAmount;

  await prisma.worksOrder.create({
    data: {
      customerName,
      customerEmail,
      customerPhone,
      customerVatNumber,

      address1,
      address2,
      city,
      county,
      postcode,
      country,

      salespersonId,
      serviceType,
      extraInfo,

      paymentMethod,
      paymentStatus,
      amountPaid,

      subtotal,
      discountTotal,
      vatAmount,
      total,

      status: "awaiting_scheduled",

lineItems: {
  create: lineItems.map((item: any) => {
    const quantity = safeNumber(item.quantity);
    const unitPrice = safeNumber(item.unitPrice);
    const discount = safeNumber(item.discount);

    return {
      shopifyVariantId: item.shopifyVariantId || null,
      title: item.title,
      sku: item.sku || "",
      quantity,
      unitPrice,
      discount,
      lineTotal: unitPrice * quantity - discount,
    };
  }),
},
    },
  });

return redirect("/app/works/awaiting-scheduled");
}

export default function CreateWorksOrderPage() {
  const { staff, variants, productSearch } = useLoaderData<typeof loader>();

  const [searchTerm, setSearchTerm] = useState(productSearch || "");

  const [salespersonId, setSalespersonId] = useState(
    staff[0]?.id ? String(staff[0].id) : "",
  );

  const [customerName, setCustomerName] = useState("");
  const [customerEmail, setCustomerEmail] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [customerVatNumber, setCustomerVatNumber] = useState("");

  const [address1, setAddress1] = useState("");
  const [address2, setAddress2] = useState("");
  const [city, setCity] = useState("");
  const [county, setCounty] = useState("");
  const [postcode, setPostcode] = useState("");
  const [country, setCountry] = useState("");

  const [serviceType, setServiceType] = useState("Repair");
  const [extraInfo, setExtraInfo] = useState("");

  const [paymentMethod, setPaymentMethod] = useState("Cash");
  const [paymentStatus, setPaymentStatus] = useState("unpaid");
  const [amountPaid, setAmountPaid] = useState("0");

  const [items, setItems] = useState<any[]>([]);

  const staffOptions = staff.map((person: any) => ({
    label: person.name,
    value: String(person.id),
  }));

  const serviceOptions = [
    { label: "Repair", value: "Repair" },
    { label: "Install", value: "Install" },
    { label: "Custom Build", value: "Custom Build" },
  ];

  const paymentOptions = [
    { label: "Cash", value: "Cash" },
    { label: "Worldpay", value: "Worldpay" },
    { label: "MyPos", value: "MyPos" },
    { label: "Bank Transfer", value: "Bank Transfer" },
  ];

  const paymentStatusOptions = [
    { label: "Unpaid", value: "unpaid" },
    { label: "Part paid", value: "part_paid" },
    { label: "Paid", value: "paid" },
  ];

  function addShopifyItem(variant: any) {
    setItems((current) => [
      ...current,
      {
        shopifyVariantId: variant.id,
        title: `${variant.product.title} - ${variant.title}`,
        sku: variant.sku || "",
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
        shopifyVariantId: null,
        title: "Custom product / service",
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
    <Page title="Create Works Order">
      <Layout>
        <Layout.Section>
          <Card>
            <Form method="get">
              <InlineStack gap="300" blockAlign="end">
                <div style={{ flex: 1 }}>
                  <TextField
                    label="Search Shopify products"
                    name="productSearch"
                    value={searchTerm}
                    onChange={setSearchTerm}
                    autoComplete="off"
                    placeholder="Search by product name or SKU"
                  />
                </div>

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
                      <Button onClick={() => addShopifyItem(variant)}>
                        Add
                      </Button>
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
              <input
                type="hidden"
                name="lineItems"
                value={JSON.stringify(items)}
              />

              <BlockStack gap="400">
                <Select
                  label="Salesperson"
                  name="salespersonId"
                  options={staffOptions}
                  value={salespersonId}
                  onChange={setSalespersonId}
                />

                <Select
                  label="Service type"
                  name="serviceType"
                  options={serviceOptions}
                  value={serviceType}
                  onChange={setServiceType}
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

                <TextField
                  label="VAT number"
                  name="customerVatNumber"
                  value={customerVatNumber}
                  onChange={setCustomerVatNumber}
                  autoComplete="off"
                  placeholder="Leave blank to charge 20% VAT"
                />

                <Text as="h2" variant="headingMd">
                  Address
                </Text>

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

                <TextField
                  label="Town / City"
                  name="city"
                  value={city}
                  onChange={setCity}
                  autoComplete="off"
                />

                <TextField
                  label="County"
                  name="county"
                  value={county}
                  onChange={setCounty}
                  autoComplete="off"
                />

                <TextField
                  label="Postcode"
                  name="postcode"
                  value={postcode}
                  onChange={setPostcode}
                  autoComplete="off"
                />

                <TextField
                  label="Country"
                  name="country"
                  value={country}
                  onChange={setCountry}
                  autoComplete="off"
                  placeholder="United Kingdom"
                />

                <Text as="h2" variant="headingMd">
                  Product details
                </Text>

                <Button onClick={addCustomItem}>Add custom line item</Button>

                {items.map((item, index) => (
                  <Card key={index}>
                    <BlockStack gap="300">
                      <TextField
                        label="Item title"
                        value={String(item.title)}
                        onChange={(value) => updateItem(index, "title", value)}
                        autoComplete="off"
                      />

                      <InlineStack gap="300">
                        <div style={{ width: "120px" }}>
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

                        <div style={{ width: "160px" }}>
                          <TextField
                            label="Unit price"
                            value={String(item.unitPrice)}
                            onChange={(value) =>
                              updateItem(index, "unitPrice", value)
                            }
                            autoComplete="off"
                            type="number"
                            prefix="£"
                          />
                        </div>

                        <div style={{ width: "160px" }}>
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

                        <div style={{ paddingTop: "28px" }}>
                          <Button
                            tone="critical"
                            onClick={() => removeItem(index)}
                          >
                            Remove
                          </Button>
                        </div>
                      </InlineStack>
                    </BlockStack>
                  </Card>
                ))}

                <TextField
                  label="Extra information"
                  name="extraInfo"
                  value={extraInfo}
                  onChange={setExtraInfo}
                  autoComplete="off"
                  multiline={4}
                  placeholder="Add repair details, install notes, custom build spec, or anything the engineer needs to know."
                />

                <Select
                  label="Payment method"
                  name="paymentMethod"
                  options={paymentOptions}
                  value={paymentMethod}
                  onChange={setPaymentMethod}
                />

                <Select
                  label="Payment status"
                  name="paymentStatus"
                  options={paymentStatusOptions}
                  value={paymentStatus}
                  onChange={setPaymentStatus}
                />

                <TextField
                  label="Amount paid"
                  name="amountPaid"
                  value={amountPaid}
                  onChange={setAmountPaid}
                  autoComplete="off"
                  type="number"
                  prefix="£"
                />

                <Text as="p">Subtotal: £{Number(totals.subtotal ?? 0).toFixed(2)}</Text>
                <Text as="p">Discount: £{Number(totals.discount ?? 0).toFixed(2)}</Text>
                <Text as="p">VAT: £{Number(totals.vatAmount ?? 0).toFixed(2)}</Text>

                <Text as="p" fontWeight="bold">
                  Total: £{Number(totals.total ?? 0).toFixed(2)}
                </Text>

                <Button submit variant="primary">
                  Save Works Order
                </Button>
              </BlockStack>
            </Form>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}