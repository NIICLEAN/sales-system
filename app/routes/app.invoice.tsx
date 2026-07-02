import { Form, useLoaderData, redirect } from "react-router";
import { useMemo, useRef, useState } from "react";
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
  Modal,
} from "@shopify/polaris";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { adjustInventoryForLineItems } from "../services/shopifyInventory.server";
import { createSaleCompat, updateSaleCompat } from "../services/saleCompat.server";
import { getSaleShippingMeta, upsertSaleShippingMeta } from "../services/saleShippingMeta.server";

const VAT_RATE = 0.2;

const SHIPPING_SERVICE_OPTIONS = [
  { value: "ireland-delivery", label: "Ireland Delivery", price: 14.95 },
  { value: "ni-uk-delivery", label: "NI / UK Delivery", price: 12.95 },
  { value: "long-heavy-parcel", label: "Long or Heavy Parcel (all countries)", price: 29.95 },
  { value: "pallet-delivery", label: "Pallet delivery", price: 100 },
  { value: "pallet-international", label: "Pallet international", price: 495 },
];

const money = (value: number) => `£${Number(value ?? 0).toFixed(2)}`;

function roundMoney(value: number) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function getShippingServiceByValue(value: string) {
  return SHIPPING_SERVICE_OPTIONS.find((option) => option.value === value) || null;
}

function getShippingServiceValueFromLabel(label: string) {
  const normalized = String(label || "").trim().toLowerCase();
  if (!normalized) return "";
  const match = SHIPPING_SERVICE_OPTIONS.find((option) => option.label.toLowerCase() === normalized);
  return match?.value || "";
}

function getPaymentStatus(total: any, amountPaid: any) {
  const roundedTotal = roundMoney(Number(total || 0));
  const roundedPaid = roundMoney(Number(amountPaid || 0));

  if (roundedPaid <= 0) return "Unpaid";
  if (roundedPaid + 0.01 < roundedTotal) return "Partially Paid";
  return "Paid";
}

function getGrossPrice(netPrice: any, isVatExempt: boolean) {
  const net = Number(netPrice || 0);
  return isVatExempt ? roundMoney(net) : roundMoney(net * (1 + VAT_RATE));
}

function withEmbeddedParamsFromRequest(request: Request, path: string) {
  const requestUrl = new URL(request.url);
  const [pathname, queryString = ""] = path.split("?");
  const nextParams = new URLSearchParams(queryString);

  for (const key of ["shop", "host", "embedded", "id_token"]) {
    const value = requestUrl.searchParams.get(key);
    if (value && !nextParams.has(key)) {
      nextParams.set(key, value);
    }
  }

  const nextQuery = nextParams.toString();
  return nextQuery ? `${pathname}?${nextQuery}` : pathname;
}

function buildOrderCustomAttributes({
  paymentMethod,
  paymentStatus,
  amountPaid,
  balanceDue,
  depositPaid,
  reference,
  staffId,
  customerVatNumber,
  vatType,
  isVatExempt,
  fulfilmentMethod,
  shippingServiceLabel,
  shippingCharge,
}: {
  paymentMethod: string;
  paymentStatus: string;
  amountPaid: number;
  balanceDue: number;
  depositPaid: boolean;
  reference: string;
  staffId: number;
  customerVatNumber: string;
  vatType: string;
  isVatExempt: boolean;
  fulfilmentMethod: string;
  shippingServiceLabel: string;
  shippingCharge: number;
}) {
  return [
    { key: "Payment Method", value: paymentMethod },
    { key: "Payment Status", value: paymentStatus },
    { key: "Amount Paid", value: money(amountPaid) },
    { key: "Balance Due", value: money(balanceDue) },
    { key: "Deposit Paid", value: depositPaid ? "Yes" : "No" },
    { key: "Reference", value: reference || "-" },
    { key: "Salesperson ID", value: String(staffId) },
    { key: "VAT Number", value: customerVatNumber || "-" },
    { key: "VAT Type", value: vatType || "Standard" },
    {
      key: "Pricing Basis",
      value: isVatExempt ? "VAT exempt net price" : "Net price + 20% VAT",
    },
    { key: "Order Type", value: fulfilmentMethod },
    { key: "Shipping Service", value: shippingServiceLabel || "-" },
    { key: "Shipping Charge", value: money(shippingCharge) },
  ];
}

async function createShopifyOrderFromInvoice({
  admin,
  shopifyCustomerId,
  customerEmail,
  customerPhone,
  isVatExempt,
  reference,
  tags,
  customAttributes,
  hasManualShippingAddress,
  customerName,
  address1,
  address2,
  city,
  county,
  postcode,
  country,
  lineItems,
  paymentStatus,
}: any) {
  const draftOrderInput = {
    customerId: shopifyCustomerId || undefined,
    email: customerEmail || undefined,
    phone: customerPhone || undefined,
    taxExempt: isVatExempt,
    note: reference || undefined,
    tags,
    customAttributes,
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
      const netUnitPrice = roundMoney(Number(item.unitPrice || 0));
      const netDiscount = roundMoney(Number(item.discount || 0));

      return {
        quantity: Number(item.quantity),
        title: item.title || "Custom item",
        sku: item.sku || undefined,
        originalUnitPriceWithCurrency: {
          amount: Number(netUnitPrice ?? 0).toFixed(2),
          currencyCode: "GBP",
        },
        taxable: !isVatExempt,
        appliedDiscount: netDiscount
          ? {
              value: netDiscount,
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
  const completeErrors = completeDraftJson.data?.draftOrderComplete?.userErrors || [];

  if (completeErrors.length > 0) {
    throw new Response(completeErrors.map((e: any) => e.message).join(", "), {
      status: 400,
    });
  }

  return completeDraftJson.data.draftOrderComplete.draftOrder.order;
}

async function autoFulfillCollectionOrder({ admin, orderId }: { admin: any; orderId: string }) {
  try {
    const fulfillmentOrdersResponse = await admin.graphql(
      `
        query FulfillmentOrdersForOrder($id: ID!) {
          order(id: $id) {
            fulfillmentOrders(first: 20) {
              nodes {
                id
                status
              }
            }
          }
        }
      `,
      { variables: { id: orderId } },
    );

    const fulfillmentOrdersJson = (await fulfillmentOrdersResponse.json()) as any;
    const fulfillmentOrders =
      fulfillmentOrdersJson?.data?.order?.fulfillmentOrders?.nodes?.filter(
        (node: any) => node?.id && node?.status !== "CLOSED" && node?.status !== "CANCELLED",
      ) || [];

    if (!fulfillmentOrders.length) return;

    const fulfillmentResponse = await admin.graphql(
      `
        mutation CreateCollectionFulfillment($fulfillment: FulfillmentV2Input!) {
          fulfillmentCreateV2(fulfillment: $fulfillment) {
            fulfillment {
              id
              status
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
          fulfillment: {
            notifyCustomer: false,
            lineItemsByFulfillmentOrder: fulfillmentOrders.map((node: any) => ({
              fulfillmentOrderId: node.id,
            })),
          },
        },
      },
    );

    const fulfillmentJson = (await fulfillmentResponse.json()) as any;
    const userErrors = fulfillmentJson?.data?.fulfillmentCreateV2?.userErrors || [];
    if (userErrors.length) {
      console.error("Auto-fulfilment userErrors:", userErrors);
    }
  } catch (error) {
    console.error("Auto-fulfilment failed:", error);
  }
}

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { invoiceId?: string };
}) {
  const { admin } = await authenticate.admin(request);

  const url = new URL(request.url);
  const productSearch = url.searchParams.get("productSearch") || "";
  const customerSearch = url.searchParams.get("customerSearch") || "";

  const editInvoiceId = url.searchParams.get("editInvoiceId");
  

  const staff = await prisma.staff.findMany({
    orderBy: { name: "asc" },
  });

  let existingInvoice = null;

if (params.invoiceId || editInvoiceId) {
  const sale = await prisma.sale.findUnique({
    where: {
      id: Number(params.invoiceId || editInvoiceId),
    },
    select: {
      id: true,
      shopifyOrderId: true,
      shopifyOrderName: true,
      customerId: true,
      customerName: true,
      customerEmail: true,
      customerVatNumber: true,
      customerPhone: true,
      address1: true,
      address2: true,
      city: true,
      county: true,
      postcode: true,
      country: true,
      reference: true,
      paymentMethod: true,
      subtotal: true,
      discountTotal: true,
      vatAmount: true,
      total: true,
      amountPaid: true,
      balanceDue: true,
      paymentStatus: true,
      depositPaid: true,
      staffId: true,
      createdAt: true,
    },
  });

  if (sale) {
    const [lineItems, staffRecord, shippingMeta] = await Promise.all([
      prisma.saleLineItem.findMany({
        where: { saleId: sale.id },
        orderBy: { id: "asc" },
      }),
      prisma.staff.findUnique({
        where: { id: sale.staffId },
      }),
      getSaleShippingMeta(sale.id),
    ]);

    existingInvoice = {
      ...sale,
      lineItems,
      staff: staffRecord,
      shippingMethod: shippingMeta.shippingMethod,
      deliveryMethod: shippingMeta.deliveryMethod || "",
      trackingNumber: shippingMeta.trackingNumber || "",
      vatType: "Standard",
    } as any;
  }
}

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
        { variables: { query: productSearch } },
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
        {
          variables: {
            query: customerSearch,
          },
        },
      );

      const customersJson = (await customersResponse.json()) as any;

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
  existingInvoice,
};
}

export async function action({
  request,
  params,
}: {
  request: Request;
  params: { invoiceId?: string };
}) {
  const { admin } = await authenticate.admin(request);

const formData = await request.formData();

const editInvoiceId = String(formData.get("editInvoiceId") || "").trim();
const isEditMode = Boolean(params.invoiceId || editInvoiceId);
const printMode = String(formData.get("printMode") || "invoice").trim().toLowerCase();
const editModeInvoiceId = Number(params.invoiceId || editInvoiceId || 0);
const manualTotalInput = roundMoney(
  Math.max(0, Number(String(formData.get("manualTotal") || "0").replace(/,/g, ""))),
);
const shippingMethod = String(formData.get("shippingMethod") || "Collection") === "Delivery" ? "Delivery" : "Collection";
const shippingServiceValue = String(formData.get("shippingService") || "").trim();
const trackingNumber = String(formData.get("trackingNumber") || "").trim();
  const staffId = Number(formData.get("staffId"));
  const selectedCustomerId = String(formData.get("customerId") || "").trim();

  const customerName =
    String(formData.get("customerName") || "").trim() || "Walk-in customer";

  const customerEmail = String(formData.get("customerEmail") || "").trim();

  const customerVatNumber = String(
    formData.get("customerVatNumber") || "",
  ).trim();

  const vatType = String(formData.get("vatType") || "Standard");
  const isVatExempt = vatType === "Exempt" || vatType === "CrossBorder";

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

  const fulfilmentMethod = String(
  formData.get("fulfilmentMethod") || "Collected",
);
    const selectedShippingService =
      shippingMethod === "Delivery"
        ? getShippingServiceByValue(shippingServiceValue) || SHIPPING_SERVICE_OPTIONS[0]
        : null;
    const shippingCharge = roundMoney(Number(selectedShippingService?.price || 0));
    const shippingServiceLabel =
      shippingMethod === "Delivery"
        ? selectedShippingService?.label || "Delivery"
        : "Shipping not required";

  let lineItems: any[] = [];
  let existingFinancials: {
    subtotal: number;
    discountTotal: number;
    vatAmount: number;
    total: number;
  } | null = null;

  try {
    const parsed = JSON.parse(String(formData.get("lineItems") || "[]"));
    lineItems = Array.isArray(parsed) ? parsed : [];
  } catch {
    lineItems = [];
  }

  if (isEditMode && lineItems.length === 0) {
    if (editModeInvoiceId > 0) {
      const existingSale = await prisma.sale.findUnique({
        where: { id: editModeInvoiceId },
        select: {
          subtotal: true,
          discountTotal: true,
          vatAmount: true,
          total: true,
        },
      });

      if (existingSale) {
        existingFinancials = {
          subtotal: Number(existingSale.subtotal || 0),
          discountTotal: Number(existingSale.discountTotal || 0),
          vatAmount: Number(existingSale.vatAmount || 0),
          total: Number(existingSale.total || 0),
        };
      }

      const existingLineItems = await prisma.saleLineItem.findMany({
        where: { saleId: editModeInvoiceId },
        orderBy: { id: "asc" },
        select: {
          shopifyVariantId: true,
          title: true,
          sku: true,
          imageUrl: true,
          quantity: true,
          unitPrice: true,
          discount: true,
          lineTotal: true,
          isCustom: true,
        },
      });

      lineItems = existingLineItems.map((item) => ({
        id: item.shopifyVariantId || "",
        type: item.isCustom ? "custom" : "product",
        title: item.title,
        sku: item.sku || "",
        imageUrl: item.imageUrl || null,
        quantity: Number(item.quantity || 0),
        unitPrice: Number(item.unitPrice || 0),
        discount: Number(item.discount || 0),
        lineTotal: Number(item.lineTotal || 0),
      }));
    }
  }

  const shouldCreateFallbackLineFromManualTotal =
    isEditMode && lineItems.length === 0 && manualTotalInput > 0;

  if (shouldCreateFallbackLineFromManualTotal) {
    lineItems = [
      {
        id: `manual-total-${editModeInvoiceId || Date.now()}`,
        type: "custom",
        title: "Manual invoice total",
        sku: "",
        quantity: 1,
        unitPrice: manualTotalInput,
        discount: 0,
        imageUrl: "",
        lineTotal: manualTotalInput,
      },
    ];
  }

  const amountPaid = roundMoney(
    Math.max(
      0,
      Number(String(formData.get("amountPaid") || "0").replace(/,/g, "")),
    ),
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
            taxExempt: isVatExempt,
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

  let subtotal = roundMoney(
    lineItems.reduce(
      (sum: number, item: any) =>
        sum + Number(item.unitPrice) * Number(item.quantity),
      0,
    ),
  );

  let discountTotal = roundMoney(
    lineItems.reduce(
      (sum: number, item: any) => sum + Number(item.discount || 0),
      0,
    ),
  );

  let netTotal = roundMoney(subtotal - discountTotal);
  netTotal = roundMoney(netTotal + shippingCharge);
  let vatAmount = isVatExempt ? 0 : roundMoney(netTotal * VAT_RATE);
  let total = roundMoney(netTotal + vatAmount);

  if (isEditMode && lineItems.length === 0 && existingFinancials) {
    if (manualTotalInput > 0) {
      subtotal = manualTotalInput;
      discountTotal = 0;
      vatAmount = 0;
      total = manualTotalInput;
      netTotal = manualTotalInput;
    } else {
      subtotal = roundMoney(existingFinancials.subtotal);
      discountTotal = roundMoney(existingFinancials.discountTotal);
      vatAmount = roundMoney(existingFinancials.vatAmount);
      total = roundMoney(existingFinancials.total);
      netTotal = roundMoney(subtotal - discountTotal);
    }
  }

  if (shouldCreateFallbackLineFromManualTotal) {
    subtotal = manualTotalInput;
    discountTotal = 0;
    vatAmount = 0;
    total = manualTotalInput;
    netTotal = manualTotalInput;
  }
  const balanceDue = roundMoney(Math.max(total - amountPaid, 0));
  const paymentStatus = getPaymentStatus(total, amountPaid);

  const hasManualShippingAddress =
    address1 || address2 || city || county || postcode || country;

const tags = [
  "Invoice App",
  paymentMethod,
    vatType,
  paymentStatus,
  fulfilmentMethod,
  shippingServiceLabel,
  depositPaid ? "Deposit Paid" : null,
].filter(Boolean) as string[];

  const customAttributes = buildOrderCustomAttributes({
    paymentMethod,
    paymentStatus,
    amountPaid,
    balanceDue,
    depositPaid,
    reference,
    staffId,
    customerVatNumber,
    vatType,
    isVatExempt,
    fulfilmentMethod,
    shippingServiceLabel,
    shippingCharge,
  });

  const shouldCreateShopifyOrder = amountPaid > 0 && total > 0 && lineItems.length > 0;

if (isEditMode) {
const invoiceId = Number(params.invoiceId || editInvoiceId);
  const existingSale = await prisma.sale.findUnique({
    where: { id: invoiceId },
    select: {
      shopifyOrderId: true,
      amountPaid: true,
      staffId: true,
    },
  });

  const resolvedStaffId = Number(staffId) > 0
    ? Number(staffId)
    : Number(existingSale?.staffId || 0);

  await updateSaleCompat({
    saleId: invoiceId,
    sale: {
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
      staffId: resolvedStaffId,
    },
    replaceLineItems: true,
    lineItems: lineItems.map((item: any) => ({
      shopifyVariantId: item.type === "custom" ? null : item.id,
      title: item.title,
      sku: item.sku,
      imageUrl: item.imageUrl || null,
      quantity: Number(item.quantity),
      unitPrice: Number(item.unitPrice),
      discount: Number(item.discount || 0),
      lineTotal: roundMoney(
        Number(item.unitPrice) * Number(item.quantity) -
          Number(item.discount || 0),
      ),
      isCustom: item.type === "custom",
    })),
  });

  if (existingSale?.shopifyOrderId) {
    const updateOrderResponse = await admin.graphql(
      `
        mutation UpdateOrder($input: OrderInput!) {
          orderUpdate(input: $input) {
            order {
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
      {
        variables: {
          input: {
            id: existingSale.shopifyOrderId,
            email: customerEmail || undefined,
            phone: customerPhone || undefined,
            note: reference || undefined,
            tags,
            customAttributes,
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
          },
        },
      },
    );

    const updateOrderJson = await updateOrderResponse.json();

    const updateErrors =
      updateOrderJson.data?.orderUpdate?.userErrors || [];

    if (updateErrors.length > 0) {
      throw new Response(updateErrors.map((e: any) => e.message).join(", "), {
        status: 400,
      });
    }

    if (shippingMethod === "Collection") {
      await autoFulfillCollectionOrder({
        admin,
        orderId: existingSale.shopifyOrderId,
      });
    }
  } else if (shouldCreateShopifyOrder) {
    try {
      const shopifyOrder = await createShopifyOrderFromInvoice({
        admin,
        shopifyCustomerId,
        customerEmail,
        customerPhone,
        isVatExempt,
        reference,
        tags,
        customAttributes,
        hasManualShippingAddress,
        customerName,
        address1,
        address2,
        city,
        county,
        postcode,
        country,
        lineItems,
        paymentStatus,
      });

      await prisma.sale.update({
        where: { id: invoiceId },
        data: {
          shopifyOrderId: shopifyOrder?.id || null,
          shopifyOrderName: shopifyOrder?.name || null,
        },
      });

      if (shippingMethod === "Collection" && shopifyOrder?.id) {
        await autoFulfillCollectionOrder({ admin, orderId: shopifyOrder.id });
      }
    } catch (error) {
      // Do not block local invoice edits if Shopify order creation fails.
      console.error("Failed to create Shopify order during invoice edit:", error);
    }

    try {
      const variantAdjustments = lineItems
        .filter((i: any) => i.type !== "custom" && i.id)
        .map((i: any) => ({ id: i.id, quantity: Number(i.quantity) }));

      if (variantAdjustments.length > 0) {
        await adjustInventoryForLineItems(admin, variantAdjustments);
      }
    } catch (err) {
      console.error("Inventory adjustment failed:", err);
    }
  }

  const previousAmountPaid = roundMoney(Number(existingSale?.amountPaid || 0));
  const paymentDelta = roundMoney(amountPaid - previousAmountPaid);

  try {
    if (paymentDelta > 0) {
      await prisma.payment.create({
        data: {
          saleId: invoiceId,
          amount: paymentDelta,
          method: (paymentMethod as any) || "Other",
          provider: paymentMethod,
          reference: reference || null,
        },
      });
    }
  } catch (err) {
    console.error("Failed to record payment:", err);
  }

  try {
    await upsertSaleShippingMeta({
      saleId: invoiceId,
      shippingMethod,
      trackingNumber,
      deliveryMethod: shippingServiceLabel,
      deliveryStatus:
        shippingMethod === "Collection"
          ? "Shipping not required"
          : trackingNumber
            ? "Tracking added"
            : "Awaiting tracking",
    });
  } catch (err) {
    console.error("Failed to save shipping meta:", err);
  }

  return redirect(withEmbeddedParamsFromRequest(request, `/app/invoices/${invoiceId}`));
}

  let shopifyOrder = null;

  if (shouldCreateShopifyOrder) {
    shopifyOrder = await createShopifyOrderFromInvoice({
      admin,
      shopifyCustomerId,
      customerEmail,
      customerPhone,
      isVatExempt,
      reference,
      tags,
      customAttributes,
      hasManualShippingAddress,
      customerName,
      address1,
      address2,
      city,
      county,
      postcode,
      country,
      lineItems,
      paymentStatus,
    });

    if (shippingMethod === "Collection" && shopifyOrder?.id) {
      await autoFulfillCollectionOrder({ admin, orderId: shopifyOrder.id });
    }
  }

const sale = await createSaleCompat({
  sale: {
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
      createdAt: new Date(),
    },
      lineItems: lineItems.map((item: any) => ({
          shopifyVariantId: item.type === "custom" ? null : item.id,
          title: item.title,
          sku: item.sku,
          imageUrl: item.imageUrl || null,
          quantity: Number(item.quantity),
          unitPrice: Number(item.unitPrice),
          discount: Number(item.discount || 0),
          lineTotal: roundMoney(
            Number(item.unitPrice) * Number(item.quantity) -
              Number(item.discount || 0),
          ),
          isCustom: item.type === "custom",
        })),
  });

  // Adjust Shopify inventory for any non-custom line items
  if (shouldCreateShopifyOrder) {
    try {
      const variantAdjustments = lineItems
        .filter((i: any) => i.type !== "custom" && i.id)
        .map((i: any) => ({ id: i.id, quantity: Number(i.quantity) }));

      if (variantAdjustments.length > 0) {
        await adjustInventoryForLineItems(admin, variantAdjustments);
      }
    } catch (err) {
      console.error("Inventory adjustment failed:", err);
    }
  }

  if (customerEmail) {
  try {
    const { generateInvoicePdf } = await import("../utils/invoice-pdf.server");
    const { sendInvoiceEmail } = await import("../utils/email.server");

    const pdfBuffer = await generateInvoicePdf(sale.id);

await sendInvoiceEmail({
  to: customerEmail,
  customerName,
  invoiceId: sale.id,
  pdfBuffer,
  paymentStatus,
});
  } catch (error) {
    console.error("Invoice email failed:", error);
  }
}

// record payment if any amount was paid
try {
  if (amountPaid > 0) {
    await prisma.payment.create({
      data: {
        saleId: sale.id,
        amount: amountPaid,
        method: (paymentMethod as any) || "Other",
        provider: paymentMethod,
        reference: reference || null,
      },
    });
  }
} catch (err) {
  console.error("Failed to record payment:", err);
}

try {
  await upsertSaleShippingMeta({
    saleId: sale.id,
    shippingMethod,
    trackingNumber,
    deliveryMethod: shippingServiceLabel,
    deliveryStatus:
      shippingMethod === "Collection"
        ? "Shipping not required"
        : trackingNumber
          ? "Tracking added"
          : "Awaiting tracking",
  });
} catch (err) {
  console.error("Failed to save shipping meta:", err);
}

  if (printMode === "none") {
    return redirect(withEmbeddedParamsFromRequest(request, `/app/invoices/${sale.id}`));
  }

  const printParams = new URLSearchParams({
    autoprint: "1",
    fulfilmentMethod,
  });

  if (printMode === "invoice" || printMode === "packing" || printMode === "both") {
    printParams.set("printMode", printMode);
  }

  return redirect(withEmbeddedParamsFromRequest(request, `/app/invoices/${sale.id}?${printParams.toString()}`));
}

export default function InvoicePage() {
const {
  staff,
  variants,
  productSearch,
  customers,
  customerSearch,
  existingInvoice,
} = useLoaderData<typeof loader>();

const isEditMode = Boolean(existingInvoice);
const formRef = useRef<HTMLFormElement | null>(null);
const printModeRef = useRef<HTMLInputElement | null>(null);
const [showPrintOptions, setShowPrintOptions] = useState(false);

function submitProformaWithPrintMode(mode: "invoice" | "both" | "none") {
  if (printModeRef.current) {
    printModeRef.current.value = mode;
  }
  formRef.current?.requestSubmit();
}

  const [searchTerm, setSearchTerm] = useState(productSearch || "");

const [customerSearchTerm, setCustomerSearchTerm] = useState(
  customerSearch || "",
);

const [customerId, setCustomerId] = useState(
  existingInvoice?.customerId || ""
);

const [staffId, setStaffId] = useState(
  existingInvoice?.staffId
    ? String(existingInvoice.staffId)
    : staff[0]?.id
      ? String(staff[0].id)
      : "",
);

const [customerName, setCustomerName] = useState(
  existingInvoice?.customerName || "",
);

const [customerEmail, setCustomerEmail] = useState(
  existingInvoice?.customerEmail || "",
);

const [customerVatNumber, setCustomerVatNumber] = useState(
  existingInvoice?.customerVatNumber || "",
);

const [vatType, setVatType] = useState(
  (existingInvoice?.vatType as any) || "Standard",
);

const [customerPhone, setCustomerPhone] = useState(
  existingInvoice?.customerPhone || "",
);

const [address1, setAddress1] = useState(
  existingInvoice?.address1 || "",
);

const [address2, setAddress2] = useState(
  existingInvoice?.address2 || "",
);

const [city, setCity] = useState(
  existingInvoice?.city || "",
);

const [county, setCounty] = useState(
  existingInvoice?.county || "",
);

const [postcode, setPostcode] = useState(
  existingInvoice?.postcode || "",
);

const [country, setCountry] = useState(
  existingInvoice?.country || "",
);

const [reference, setReference] = useState(
  existingInvoice?.reference || "",
);

const [paymentMethod, setPaymentMethod] = useState(
  existingInvoice?.paymentMethod || "Cash",
);

// leave collected for now
const [fulfilmentMethod, setFulfilmentMethod] =
  useState(existingInvoice?.shippingMethod === "Delivery" ? "Delivery" : "Collected");

const [shippingMethod, setShippingMethod] = useState(
  existingInvoice?.shippingMethod === "Delivery" ? "Delivery" : "Collection",
);

const [shippingService, setShippingService] = useState(
  existingInvoice?.shippingMethod === "Delivery"
    ? getShippingServiceValueFromLabel(existingInvoice?.deliveryMethod || "")
    : "",
);

const [trackingNumber, setTrackingNumber] = useState(
  existingInvoice?.trackingNumber || "",
);

const [items, setItems] = useState<any[]>(
  existingInvoice?.lineItems?.map((item: any) => ({
    type: item.isCustom ? "custom" : "shopify",
    id: item.shopifyVariantId || `custom-${item.id}`,
    title: item.title,
    sku: item.sku || "",
    quantity: item.quantity,
    unitPrice: item.unitPrice,
    discount: item.discount || 0,
    imageUrl: item.imageUrl || "",
  })) || [],
);

const [amountPaid, setAmountPaid] = useState(
  String(existingInvoice?.amountPaid || 0),
);

const [manualTotal, setManualTotal] = useState(
  String(existingInvoice?.total || 0),
);

const [depositPaid, setDepositPaid] = useState(
  existingInvoice?.depositPaid || false,
);

const [showAddress, setShowAddress] = useState(
  Boolean(
    existingInvoice?.address1 ||
      existingInvoice?.city ||
      existingInvoice?.postcode,
  ),
);

  const staffOptions = staff.map((person: any) => ({
    label: person.name,
    value: String(person.id),
  }));

  const paymentOptions = [
    { label: "Not paid", value: "Not paid" },
    { label: "Deposit", value: "Deposit" },
    { label: "Cash", value: "Cash" },
    { label: "Worldpay", value: "Worldpay" },
    { label: "MyPos", value: "MyPos" },
    { label: "Bank Transfer", value: "Bank Transfer" },
  ];

  const fulfilmentOptions = [
  { label: "Collected", value: "Collected" },
  { label: "Collecting", value: "Collecting" },
  { label: "Delivery", value: "Delivery" },
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

  function addCustomItem(event?: React.MouseEvent<HTMLButtonElement>) {
    event?.preventDefault();

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
    const subtotal = roundMoney(
      items.reduce(
        (sum, item) => sum + Number(item.unitPrice) * Number(item.quantity),
        0,
      ),
    );

    const discount = roundMoney(
      items.reduce((sum, item) => sum + Number(item.discount || 0), 0),
    );

    const selectedShippingService =
      shippingMethod === "Delivery"
        ? getShippingServiceByValue(shippingService)
        : null;
    const shippingCharge = roundMoney(Number(selectedShippingService?.price || 0));
    const netTotal = roundMoney(subtotal - discount + shippingCharge);
    const vatAmount = (vatType === "Exempt" || vatType === "CrossBorder")
      ? 0
      : roundMoney(netTotal * VAT_RATE);
    const total = roundMoney(netTotal + vatAmount);
    const paid = roundMoney(Math.max(0, Number(amountPaid || 0)));
    const balanceDue = roundMoney(Math.max(total - paid, 0));
    const paymentStatus = getPaymentStatus(total, paid);

    if (isEditMode && items.length === 0) {
      const overrideTotal = roundMoney(Math.max(0, Number(manualTotal || 0)));
      const overridePaid = roundMoney(Math.max(0, Number(amountPaid || 0)));
      const overrideBalanceDue = roundMoney(Math.max(overrideTotal - overridePaid, 0));
      const overrideStatus = getPaymentStatus(overrideTotal, overridePaid);

      return {
        subtotal: overrideTotal,
        discount: 0,
        netTotal: overrideTotal,
        vatAmount: 0,
        total: overrideTotal,
        shippingCharge,
        paid: overridePaid,
        balanceDue: overrideBalanceDue,
        paymentStatus: overrideStatus,
      };
    }

    return {
      subtotal,
      discount,
      netTotal,
      vatAmount,
      total,
      shippingCharge,
      paid,
      balanceDue,
      paymentStatus,
    };
  }, [items, vatType, amountPaid, isEditMode, manualTotal, shippingMethod, shippingService]);

  const deliveryRequiresService = shippingMethod === "Delivery" && !shippingService;

  return (
<Page
  title={existingInvoice ? `Edit INV-${existingInvoice.id}` : "Create Invoice"}
      subtitle="Search products, add invoice lines, then complete the customer and payment details."
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
                        <IndexTable.Cell>{customer.displayName}</IndexTable.Cell>
                        <IndexTable.Cell>{customer.email || "-"}</IndexTable.Cell>
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

                  <div
                    style={{
                      maxHeight: 460,
                      overflowY: "auto",
                      overflowX: "auto",
                    }}
                  >
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
                        { title: "Net Price" },
                        { title: "Action" },
                      ]}
                      selectable={false}
                    >
                      {variants.map((variant: any, index: number) => {
                        const imageUrl =
                          variant.image?.url ||
                          variant.product?.featuredImage?.url;

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
                  </div>

                  {variants.length === 0 && (
                    <Text as="p" tone="subdued">
                      No products found.
                    </Text>
                  )}
                </BlockStack>
              </Card>
            )}

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
                      No items added yet. Search for a Shopify product or add a
                      custom item.
                    </Text>
                  </Box>
                ) : (
                  <BlockStack gap="300">
                    {items.map((item, index) => (
                      <Card key={item.id || index}>
                        <BlockStack gap="300">
                          <InlineStack align="space-between" blockAlign="start">
                            <InlineStack gap="300" blockAlign="center">
                              {item.imageUrl && (
                                <img
                                  src={item.imageUrl}
                                  alt={item.title}
                                  style={{
                                    width: 52,
                                    height: 52,
                                    objectFit: "cover",
                                    borderRadius: 8,
                                    border: "1px solid #ddd",
                                  }}
                                />
                              )}

                              <div>
                                <Text as="p" fontWeight="bold">
                                  {item.title}
                                </Text>

                                {item.sku && (
                                  <Text as="p" tone="subdued">
                                    SKU: {item.sku}
                                  </Text>
                                )}

                                {item.type === "custom" && (
                                  <Badge tone="info">Custom</Badge>
                                )}
                              </div>
                            </InlineStack>

                            <Button
                              tone="critical"
                              onClick={() => {
                                removeItem(index);
                              }}
                            >
                              Remove
                            </Button>
                          </InlineStack>

                          {item.type === "custom" && (
                            <InlineStack gap="300">
                              <div style={{ flex: 1 }}>
                                <TextField
                                  label="Item name"
                                  value={String(item.title)}
                                  onChange={(value) =>
                                    updateItem(index, "title", value)
                                  }
                                  autoComplete="off"
                                />
                              </div>

                              <div style={{ width: 180 }}>
                                <TextField
                                  label="SKU"
                                  value={String(item.sku)}
                                  onChange={(value) =>
                                    updateItem(index, "sku", value)
                                  }
                                  autoComplete="off"
                                />
                              </div>
                            </InlineStack>
                          )}

                          <InlineStack gap="300">
                            <div style={{ width: 120 }}>
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

                            <div style={{ width: 160 }}>
                              <TextField
                                label="Net price before VAT"
                                value={String(item.unitPrice)}
                                onChange={(value) =>
                                  updateItem(index, "unitPrice", value)
                                }
                                autoComplete="off"
                                type="number"
                                prefix="£"
                              />
                            </div>

                            <div style={{ width: 160 }}>
                              <TextField
                                label="Net discount"
                                value={String(item.discount)}
                                onChange={(value) =>
                                  updateItem(index, "discount", value)
                                }
                                autoComplete="off"
                                type="number"
                                prefix="£"
                              />
                            </div>

                            <div style={{ paddingTop: 28 }}>
                              <Text as="p" fontWeight="bold">
                                Net line total:{" "}
                                {money(
                                  roundMoney(
                                    Number(item.unitPrice) *
                                      Number(item.quantity) -
                                      Number(item.discount || 0),
                                  ),
                                )}
                              </Text>

                              <Text as="p" tone="subdued">
                                Shopify net unit price sent:{" "}
                                {money(Number(item.unitPrice || 0))}
                              </Text>
                            </div>
                          </InlineStack>
                        </BlockStack>
                      </Card>
                    ))}
                  </BlockStack>
                )}
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>

      <div style={{ marginTop: 16 }}>
        <Form method="post" ref={formRef}>
          <input
            ref={printModeRef}
            type="hidden"
            name="printMode"
            value={isEditMode ? "none" : "invoice"}
            readOnly
          />
          <input type="hidden" name="lineItems" value={JSON.stringify(items)} />
          <input type="hidden" name="manualTotal" value={manualTotal} />
          <input type="hidden" name="customerId" value={customerId} />
          <input
  type="hidden"
  name="editInvoiceId"
  value={existingInvoice?.id || ""}
/>

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
                          onClick={() => {
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
                      <div style={{ flex: 1 }}>
                        <Select
                          label="VAT type"
                          options={[
                            { label: "Standard 20%", value: "Standard" },
                            { label: "VAT exempt", value: "Exempt" },
                            { label: "Cross-border", value: "CrossBorder" },
                          ]}
                          onChange={setVatType}
                          value={vatType}
                        />

                        <input type="hidden" name="vatType" value={vatType} />
                      </div>
                    </InlineStack>

                    <Button
                      onClick={() => {
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

                      <div style={{ flex: 1 }}>
                        <Select
                          label="Order type"
                          name="fulfilmentMethod"
                          options={fulfilmentOptions}
                          value={fulfilmentMethod}
                          onChange={setFulfilmentMethod}
                        />
                      </div>
                    </InlineStack>

                    <InlineStack gap="300">
                      <div style={{ flex: 1 }}>
                        <Select
                          label="Shipping status"
                          name="shippingMethod"
                          options={[
                            { label: "Collection", value: "Collection" },
                            { label: "Delivery", value: "Delivery" },
                          ]}
                          value={shippingMethod}
                          onChange={(value) => {
                            setShippingMethod(value);
                            if (value !== "Delivery") {
                              setShippingService("");
                            }
                          }}
                        />
                      </div>

                      {shippingMethod === "Delivery" ? (
                        <div style={{ flex: 1 }}>
                          <Select
                            label="Shipping method"
                            name="shippingService"
                            options={[
                              { label: "Select delivery method", value: "" },
                              ...SHIPPING_SERVICE_OPTIONS.map((option) => ({
                                label: `${option.label} - ${money(option.price)}`,
                                value: option.value,
                              })),
                            ]}
                            value={shippingService}
                            onChange={setShippingService}
                          />
                        </div>
                      ) : null}

                      <div style={{ flex: 1 }}>
                        <TextField
                          label="Tracking number"
                          name="trackingNumber"
                          value={trackingNumber}
                          onChange={setTrackingNumber}
                          autoComplete="off"
                          placeholder="Optional"
                        />
                      </div>
                    </InlineStack>

                    {deliveryRequiresService ? (
                      <Text as="p" tone="critical">
                        Delivery orders require a shipping method.
                      </Text>
                    ) : null}

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
                        <Text as="p">Net subtotal</Text>
                        <Text as="p">{money(totals.subtotal)}</Text>
                      </InlineStack>

                      <InlineStack align="space-between">
                        <Text as="p">Discount</Text>
                        <Text as="p">{money(totals.discount)}</Text>
                      </InlineStack>

                      <InlineStack align="space-between">
                        <Text as="p">Net total</Text>
                        <Text as="p">{money(totals.netTotal)}</Text>
                      </InlineStack>

                      <InlineStack align="space-between">
                        <Text as="p">Shipping</Text>
                        <Text as="p">{money(totals.shippingCharge || 0)}</Text>
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

                    <BlockStack gap="100">
                      <InlineStack align="space-between">
                        <Text as="p">Fulfilment</Text>
                        <Text as="p">{shippingMethod}</Text>
                      </InlineStack>
                      {shippingMethod === "Delivery" ? (
                        <InlineStack align="space-between">
                          <Text as="p">Delivery method</Text>
                          <Text as="p">
                            {getShippingServiceByValue(shippingService)?.label || "Not selected"}
                          </Text>
                        </InlineStack>
                      ) : null}
                    </BlockStack>

                    <Divider />

                    <BlockStack gap="300">
                      {isEditMode && items.length === 0 ? (
                        <TextField
                          label="Invoice total (no line items)"
                          value={manualTotal}
                          onChange={setManualTotal}
                          autoComplete="off"
                          type="number"
                          prefix="£"
                        />
                      ) : null}

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

                    {isEditMode ? (
                      <Button submit variant="primary" fullWidth disabled={deliveryRequiresService}>
                        Save Changes
                      </Button>
                    ) : (
                      <Button
                        variant="primary"
                        fullWidth
                        disabled={deliveryRequiresService}
                        onClick={() => setShowPrintOptions(true)}
                      >
                        Save Proforma
                      </Button>
                    )}

                    <Modal
                      open={!isEditMode && showPrintOptions}
                      onClose={() => setShowPrintOptions(false)}
                      title="Print after saving proforma"
                    >
                      <Modal.Section>
                        <BlockStack gap="300">
                          <Text as="p" variant="bodyMd">
                            Choose to print one sheet (invoice) or two sheets (invoice + packing slip).
                          </Text>

                          <InlineStack gap="200" wrap>
                            <Button
                              variant="primary"
                              onClick={() => submitProformaWithPrintMode("invoice")}
                            >
                              Print one sheet (invoice)
                            </Button>

                            <Button onClick={() => submitProformaWithPrintMode("both")}>
                              Print two sheets
                            </Button>

                            <Button onClick={() => submitProformaWithPrintMode("none")}>
                              Save without printing
                            </Button>
                          </InlineStack>
                        </BlockStack>
                      </Modal.Section>
                    </Modal>
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