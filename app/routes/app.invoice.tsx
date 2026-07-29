import { Form, useLoaderData, useNavigation, redirect } from "react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";
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
  Banner,
} from "@shopify/polaris";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { pushNewPaymentsToXero } from "../services/xero.server";
import { adjustInventoryForLineItems } from "../services/shopifyInventory.server";
import { createSaleCompat, updateSaleCompat } from "../services/saleCompat.server";
import { getSaleShippingMeta, upsertSaleShippingMeta } from "../services/saleShippingMeta.server";
import { getInvoiceDiscountMeta, upsertInvoiceDiscountMeta } from "../services/invoiceDiscountMeta.server";
import {
  calculateInvoiceVat,
  normalizeDeliveryWorkflowStatus,
  shouldAutoFulfillOrder,
  shouldCreateShopifyOrder,
} from "../utils/invoice-workflow";

const VAT_RATE = 0.2;

const recentInvoiceSubmissions = new Map<string, { createdAt: number; saleId?: number }>();
const INVOICE_SUBMISSION_TTL_MS = 5 * 60 * 1000;

const SHIPPING_SERVICE_OPTIONS = [
  { value: "ireland-delivery", label: "Ireland Delivery", price: 14.95 },
  { value: "ni-uk-delivery", label: "NI / UK Delivery", price: 12.95 },
  { value: "long-heavy-parcel", label: "Long or Heavy Parcel (all countries)", price: 29.95 },
  { value: "international-parcel-large", label: "International Parcel Large", price: 175 },
  { value: "international-parcel-small", label: "International Parcel Small", price: 95 },
  { value: "pallet-delivery", label: "Pallet delivery", price: 100 },
  { value: "pallet-international", label: "Pallet international", price: 495 },
  { value: "free-with-other-delivery", label: "Free with other delivery", price: 0 },
];

const DELIVERY_STATUS_OPTIONS = [
  { label: "Delivery required", value: "Delivery required", tone: "critical" as const },
  { label: "In progress", value: "In progress", tone: "warning" as const },
  { label: "Installation", value: "Installation", tone: "warning" as const },
  { label: "Fulfilled", value: "Fulfilled", tone: "success" as const },
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

function getDeliveryStatusTone(status: string) {
  const normalized = String(status || "").trim().toLowerCase();
  if (normalized === "fulfilled") return "success";
  if (normalized === "in progress") return "warning";
  return "critical";
}

function buildShippingLineItem(shippingMethod: string, shippingServiceLabel: string, shippingCharge: number) {
  if (shippingMethod !== "Delivery" || shippingCharge <= 0) return null;

  return {
    id: `shipping-${shippingServiceLabel.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    type: "custom",
    title: shippingServiceLabel || "Shipping",
    sku: "SHIPPING",
    quantity: 1,
    unitPrice: roundMoney(shippingCharge),
    discount: 0,
    imageUrl: "",
    isShipping: true,
  };
}

function addShippingLineItem(items: Array<any>, shippingLineItem: any | null) {
  return shippingLineItem ? [...items, shippingLineItem] : items;
}

function getRecentInvoiceSubmission(submissionKey: string) {
  const now = Date.now();

  for (const [key, value] of recentInvoiceSubmissions.entries()) {
    if (now - value.createdAt > INVOICE_SUBMISSION_TTL_MS) {
      recentInvoiceSubmissions.delete(key);
    }
  }

  return recentInvoiceSubmissions.get(submissionKey) || null;
}

function setRecentInvoiceSubmission(submissionKey: string, saleId?: number) {
  recentInvoiceSubmissions.set(submissionKey, {
    createdAt: Date.now(),
    saleId,
  });
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

function withEmbeddedParamsFromRequest(request: Request, path: string, fallbackParams?: Record<string, string>) {
  const requestUrl = new URL(request.url);
  const [pathname, queryString = ""] = path.split("?");
  const nextParams = new URLSearchParams(queryString);

  for (const key of ["shop", "host", "embedded", "id_token"]) {
    const value = requestUrl.searchParams.get(key) || fallbackParams?.[key] || "";
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
  trackingNumber,
  deliveryWorkflowStatus,
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
  trackingNumber: string;
  deliveryWorkflowStatus: string;
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
    { key: "Delivery Workflow", value: deliveryWorkflowStatus || "-" },
    { key: "Tracking Number", value: trackingNumber || "-" },
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
      const grossUnitPrice = getGrossPrice(netUnitPrice, isVatExempt);
      const grossDiscount = isVatExempt
        ? netDiscount
        : roundMoney(netDiscount * (1 + VAT_RATE));

      return {
        quantity: Number(item.quantity),
        title: item.title || "Custom item",
        sku: item.sku || undefined,
        originalUnitPriceWithCurrency: {
          amount: Number(grossUnitPrice ?? 0).toFixed(2),
          currencyCode: "GBP",
        },
        // Prices sent to Shopify are VAT-inclusive. Tax is disabled on line items
        // to prevent Shopify double-taxing; VAT is tracked in our local records.
        taxable: false,
        appliedDiscount: grossDiscount
          ? {
              value: grossDiscount,
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
        mutation CreateCollectionFulfillment($fulfillment: FulfillmentInput!) {
          fulfillmentCreate(fulfillment: $fulfillment) {
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
            notifyCustomer: true,
            lineItemsByFulfillmentOrder: fulfillmentOrders.map((node: any) => ({
              fulfillmentOrderId: node.id,
            })),
          },
        },
      },
    );

    const fulfillmentJson = (await fulfillmentResponse.json()) as any;
    const userErrors = fulfillmentJson?.data?.fulfillmentCreate?.userErrors || [];
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
  const embeddedParams = {
    shop: url.searchParams.get("shop") || "",
    host: url.searchParams.get("host") || "",
    embedded: url.searchParams.get("embedded") || "",
    id_token: url.searchParams.get("id_token") || "",
  };

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
        deliveryAddress1: true,
        deliveryAddress2: true,
        deliveryCity: true,
        deliveryCounty: true,
        deliveryPostcode: true,
        deliveryCountry: true,
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
      // Load vatType via raw SQL to avoid crash on legacy DBs where column may not exist yet
      let saleVatType = "Standard";
      try {
        const vtRows = await prisma.$queryRaw<Array<{ vatType: string | null }>>`
          SELECT "vatType"::text FROM "Sale" WHERE id = ${sale.id} LIMIT 1
        `;
        if (vtRows.length > 0) saleVatType = vtRows[0].vatType ?? "Standard";
      } catch {
        // Column doesn't exist yet — use default
      }
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
      const discountMeta = await getInvoiceDiscountMeta(sale.id);

      existingInvoice = {
        ...sale,
        vatType: saleVatType,
        lineItems: lineItems.filter((item: any) => item.sku !== "SHIPPING"),
        staff: staffRecord,
        shippingMethod: shippingMeta.shippingMethod,
        deliveryMethod: shippingMeta.deliveryMethod || "",
        trackingNumber: shippingMeta.trackingNumber || "",
        invoiceDiscountType: discountMeta.discountType || "amount",
        invoiceDiscountValue: discountMeta.discountValue ?? 0,
        invoiceDiscountAmount: discountMeta.discountAmount ?? 0,
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
    embeddedParams,
  };
}

type PaymentMethodEnum = "Cash" | "Card" | "BankTransfer" | "MyPos" | "Worldpay" | "Other";

function normalizePaymentMethod(method: string): PaymentMethodEnum {
  const m = String(method || "").trim().toLowerCase().replace(/\s+/g, "");
  if (m === "cash") return "Cash";
  if (m === "card") return "Card";
  if (m === "banktransfer") return "BankTransfer";
  if (m === "mypos") return "MyPos";
  if (m === "worldpay") return "Worldpay";
  return "Other";
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
const submissionKey = String(formData.get("submissionKey") || "").trim();
const printMode = String(formData.get("printMode") || "invoice").trim().toLowerCase();
const editModeInvoiceId = Number(params.invoiceId || editInvoiceId || 0);
const manualTotalInput = roundMoney(
  Math.max(0, Number(String(formData.get("manualTotal") || "0").replace(/,/g, ""))),
);
const shippingMethod = String(formData.get("shippingMethod") || "Collection") === "Delivery" ? "Delivery" : "Collection";
const shippingServiceValue = String(formData.get("shippingService") || "").trim();
const customShippingLabelInput = String(formData.get("customShippingLabel") || "Custom Delivery").trim();
const customShippingPriceInput = roundMoney(Math.max(0, Number(String(formData.get("customShippingPrice") || "0").replace(/,/g, ""))));
const paymentDateInput = String(formData.get("paymentDate") || "").trim();
const trackingNumber = String(formData.get("trackingNumber") || "").trim();
const deliveryWorkflowStatusInput = String(formData.get("deliveryWorkflowStatus") || "Delivery required").trim();
const invoiceDiscountType = String(formData.get("invoiceDiscountType") || "amount").trim() === "percent" ? "percent" : "amount";
const invoiceDiscountValue = Math.max(0, Number(String(formData.get("invoiceDiscountValue") || "0").replace(/,/g, "")) || 0);
const embeddedParamsFromForm = {
  shop: String(formData.get("shop") || "").trim(),
  host: String(formData.get("host") || "").trim(),
  embedded: String(formData.get("embedded") || "").trim(),
  id_token: String(formData.get("id_token") || "").trim(),
};
const redirectWithEmbedded = (path: string) =>
  redirect(withEmbeddedParamsFromRequest(request, path, embeddedParamsFromForm));

  if (!isEditMode && submissionKey) {
    const previousSubmission = getRecentInvoiceSubmission(submissionKey);

    if (previousSubmission?.saleId) {
      return redirectWithEmbedded(`/app/invoices/${previousSubmission.saleId}`);
    }

    if (previousSubmission) {
      return redirectWithEmbedded("/app/invoices");
    }

    setRecentInvoiceSubmission(submissionKey);
  }
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
  const deliveryAddress1 = String(formData.get("deliveryAddress1") || "").trim();
  const deliveryAddress2 = String(formData.get("deliveryAddress2") || "").trim();
  const deliveryCity = String(formData.get("deliveryCity") || "").trim();
  const deliveryCounty = String(formData.get("deliveryCounty") || "").trim();
  const deliveryPostcode = String(formData.get("deliveryPostcode") || "").trim();
  const deliveryCountry = String(formData.get("deliveryCountry") || "").trim();

  const reference = String(formData.get("reference") || "").trim();
  const paymentMethod = String(formData.get("paymentMethod") || "");

  const fulfilmentMethod = String(
  formData.get("fulfilmentMethod") || "Collected",
);
    const selectedShippingService =
      shippingMethod === "Delivery" && shippingServiceValue !== "custom"
        ? getShippingServiceByValue(shippingServiceValue) || SHIPPING_SERVICE_OPTIONS[0]
        : null;
    const shippingCharge = shippingMethod === "Delivery"
      ? (shippingServiceValue === "custom" ? customShippingPriceInput : roundMoney(Number(selectedShippingService?.price || 0)))
      : 0;
    const shippingServiceLabel =
      shippingMethod === "Delivery"
        ? (shippingServiceValue === "custom" ? customShippingLabelInput || "Custom Delivery" : selectedShippingService?.label || "Delivery")
        : "Shipping not required";
    const deliveryWorkflowStatus = normalizeDeliveryWorkflowStatus(
      shippingMethod,
      deliveryWorkflowStatusInput,
    );

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

      lineItems = existingLineItems
        .filter((item) => item.sku !== "SHIPPING")
        .map((item) => ({
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
    // First check if a customer already exists with this email
    if (customerEmail) {
      try {
        const lookupResponse = await admin.graphql(
          `
            query CustomerByEmail($query: String!) {
              customers(first: 1, query: $query) {
                edges {
                  node { id }
                }
              }
            }
          `,
          { variables: { query: `email:${customerEmail}` } },
        );
        const lookupJson = (await lookupResponse.json()) as any;
        const existing = lookupJson.data?.customers?.edges?.[0]?.node;
        if (existing?.id) {
          shopifyCustomerId = existing.id;
        }
      } catch (e) {
        console.error("Customer email lookup failed:", e);
      }
    }

    if (!shopifyCustomerId && !isEditMode) {
      const [firstName, ...rest] = customerName.split(" ");      const lastName = rest.join(" ");

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
        // If email already taken, try looking up by email one more time
        const emailTakenError = customerErrors.find((e: any) =>
          String(e.message).toLowerCase().includes("email") &&
          String(e.message).toLowerCase().includes("taken")
        );
        if (emailTakenError && customerEmail) {
          try {
            const retryLookup = await admin.graphql(
              `
                query CustomerByEmail($query: String!) {
                  customers(first: 1, query: $query) {
                    edges { node { id } }
                  }
                }
              `,
              { variables: { query: `email:${customerEmail}` } },
            );
            const retryJson = (await retryLookup.json()) as any;
            const found = retryJson.data?.customers?.edges?.[0]?.node;
            if (found?.id) {
              shopifyCustomerId = found.id;
            }
          } catch (e) {
            console.error("Customer retry lookup failed:", e);
          }
        }

        if (!shopifyCustomerId) {
          throw new Response(customerErrors.map((e: any) => e.message).join(", "), {
            status: 400,
          });
        }
      } else {
        shopifyCustomerId = createCustomerJson.data.customerCreate.customer.id;
      }
    }
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

  const invoiceDiscountAmount = roundMoney(
    invoiceDiscountType === "percent"
      ? Math.max(0, roundMoney((subtotal - discountTotal + shippingCharge) * (invoiceDiscountValue / 100)))
      : Math.min(Math.max(0, invoiceDiscountValue), Math.max(0, subtotal - discountTotal + shippingCharge)),
  );

  const invoiceNetTotal = roundMoney(Math.max(0, subtotal - discountTotal + shippingCharge - invoiceDiscountAmount));
  const invoiceVatAmount = calculateInvoiceVat(invoiceNetTotal, isVatExempt, VAT_RATE);
  const invoiceTotal = roundMoney(invoiceNetTotal + invoiceVatAmount);
  const invoiceBalanceDue = roundMoney(Math.max(invoiceTotal - amountPaid, 0));

  const shippingLineItem = buildShippingLineItem(shippingMethod, shippingServiceLabel, shippingCharge);
  const invoiceLineItems = addShippingLineItem(lineItems, shippingLineItem);

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
    trackingNumber,
    deliveryWorkflowStatus,
  });

  const createShopifyOrder = shouldCreateShopifyOrder(invoiceTotal, invoiceLineItems.length, paymentStatus);
  const autoFulfillOrder = shouldAutoFulfillOrder(shippingMethod, fulfilmentMethod);

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
      deliveryAddress1: deliveryAddress1 || null,
      deliveryAddress2: deliveryAddress2 || null,
      deliveryCity: deliveryCity || null,
      deliveryCounty: deliveryCounty || null,
      deliveryPostcode: deliveryPostcode || null,
      deliveryCountry: deliveryCountry || null,
      reference,
      paymentMethod,
      subtotal,
      discountTotal,
      vatAmount: invoiceVatAmount,
      total: invoiceTotal,
      amountPaid,
      balanceDue: invoiceBalanceDue,
      paymentStatus: getPaymentStatus(invoiceTotal, amountPaid),
      depositPaid,
      vatType,
      staffId: resolvedStaffId,
    },
    replaceLineItems: true,
    lineItems: invoiceLineItems.map((item: any) => ({
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
            // Note: `phone` is not a valid top-level field on OrderInput —
            // it only exists within shippingAddress/billingAddress below.
            note: reference || undefined,
            tags,
            customAttributes,
            shippingAddress: hasManualShippingAddress
              ? (() => {
                  const parts = customerName.trim().split(/\s+/);
                  const firstName = parts.slice(0, -1).join(" ") || parts[0];
                  const lastName = parts.length > 1 ? parts[parts.length - 1] : parts[0];
                  return {
                    firstName,
                    lastName,
                    address1,
                    address2,
                    city,
                    province: county,
                    zip: postcode,
                    country,
                    phone: customerPhone || undefined,
                  };
                })()
              : undefined,
          },
        },
      },
    );

    const updateOrderJson = await updateOrderResponse.json();

    const updateErrors =
      updateOrderJson.data?.orderUpdate?.userErrors || [];

    if (updateErrors.length > 0) {
      console.error(
        `[invoice edit] Shopify orderUpdate userErrors for order ${existingSale.shopifyOrderId}:`,
        updateErrors.map((e: any) => e.message).join(", "),
      );
      // Don't block the local save — fall through to redirect
    }

    if (autoFulfillOrder) {
      await autoFulfillCollectionOrder({
        admin,
        orderId: existingSale.shopifyOrderId,
      });
    }
  } else if (createShopifyOrder) {
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
        lineItems: invoiceLineItems,
        paymentStatus: getPaymentStatus(invoiceTotal, amountPaid),
      });

      await prisma.sale.update({
        where: { id: invoiceId },
        data: {
          shopifyOrderId: shopifyOrder?.id || null,
          shopifyOrderName: shopifyOrder?.name || null,
        },
      });

      await upsertInvoiceDiscountMeta({
        saleId: invoiceId,
        discountType: invoiceDiscountType,
        discountValue: invoiceDiscountValue,
        discountAmount: invoiceDiscountAmount,
      });

      if (autoFulfillOrder && shopifyOrder?.id) {
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
      const editPayment = await prisma.payment.create({
        data: {
          saleId: invoiceId,
          amount: paymentDelta,
          method: normalizePaymentMethod(paymentMethod),
          provider: paymentMethod,
          reference: reference || null,
        },
      });
      if (paymentDateInput) {
        await prisma.$executeRaw`UPDATE "Payment" SET "paidAt" = ${new Date(paymentDateInput)}::timestamp WHERE id = ${editPayment.id}`.catch(() => {});
      }
      // Auto-push the new payment to Xero (fire-and-forget, errors logged not thrown)
      pushNewPaymentsToXero(invoiceId).catch((err) =>
        console.error("Auto Xero push failed (edit):", err)
      );
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
      deliveryStatus: deliveryWorkflowStatus,
      // Only set Fulfilled; if not auto-fulfilling, preserve whatever status was set previously
      // (e.g. a delivery order manually marked Fulfilled shouldn't revert to Unfulfilled on edit).
      fulfillmentStatus: autoFulfillOrder ? "Fulfilled" : null,
    });
  } catch (err) {
    console.error("Failed to save shipping meta:", err);
  }

  return redirectWithEmbedded(`/app/invoices/${invoiceId}`);
}

  let shopifyOrder = null;

  if (createShopifyOrder) {
    try {
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
        lineItems: invoiceLineItems,
        paymentStatus,
      });

      if (autoFulfillOrder && shopifyOrder?.id) {
        await autoFulfillCollectionOrder({ admin, orderId: shopifyOrder.id });
      }
    } catch (error) {
      // Do not block local invoice creation if Shopify order creation fails.
      console.error("Failed to create Shopify order during invoice creation:", error);
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
    deliveryAddress1: deliveryAddress1 || null,
    deliveryAddress2: deliveryAddress2 || null,
    deliveryCity: deliveryCity || null,
    deliveryCounty: deliveryCounty || null,
    deliveryPostcode: deliveryPostcode || null,
    deliveryCountry: deliveryCountry || null,
    reference,
    paymentMethod,
    subtotal,
    discountTotal,
    vatAmount: invoiceVatAmount,
      total: invoiceTotal,
    amountPaid,
      balanceDue: invoiceBalanceDue,
      paymentStatus: getPaymentStatus(invoiceTotal, amountPaid),
    depositPaid,
    vatType,
    staffId,
    createdAt: new Date(),
  },
  lineItems: invoiceLineItems.map((item: any) => ({
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

  if (!isEditMode && submissionKey) {
    setRecentInvoiceSubmission(submissionKey, sale.id);
  }

  await upsertInvoiceDiscountMeta({
    saleId: sale.id,
    discountType: invoiceDiscountType,
    discountValue: invoiceDiscountValue,
    discountAmount: invoiceDiscountAmount,
  });

  // Adjust Shopify inventory for any non-custom line items
  if (createShopifyOrder) {
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

  // Fire-and-forget — PDF generation (Puppeteer) + SMTP can take 10-30s.
  // Awaiting them blocks the redirect and makes the UI appear frozen.
  if (customerEmail) {
    (async () => {
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
        console.log(`[email] Proforma emailed to ${customerEmail} for sale ${sale.id}`);
      } catch (error: any) {
        console.error("Invoice email failed:", error);
      }
    })();
  }

// record payment if any amount was paid
try {
  if (amountPaid > 0) {
    const createPayment = await prisma.payment.create({
      data: {
        saleId: sale.id,
        amount: amountPaid,
        method: normalizePaymentMethod(paymentMethod),
        provider: paymentMethod,
        reference: reference || null,
      },
    });
    if (paymentDateInput) {
      await prisma.$executeRaw`UPDATE "Payment" SET "paidAt" = ${new Date(paymentDateInput)}::timestamp WHERE id = ${createPayment.id}`.catch(() => {});
    }
    // Auto-push the new payment to Xero (fire-and-forget, errors logged not thrown)
    pushNewPaymentsToXero(sale.id).catch((err) =>
      console.error("Auto Xero push failed (create):", err)
    );
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
    deliveryStatus: deliveryWorkflowStatus,
    fulfillmentStatus: autoFulfillOrder ? "Fulfilled" : "Unfulfilled",
  });
} catch (err) {
  console.error("Failed to save shipping meta:", err);
}

  if (printMode === "none") {
    return redirectWithEmbedded(`/app/invoices/${sale.id}?_=${Date.now()}`);
  }

  const printParams = new URLSearchParams({
    autoprint: "1",
    fulfilmentMethod,
  });

  if (printMode === "invoice" || printMode === "packing" || printMode === "both") {
    printParams.set("printMode", printMode);
  }

  return redirectWithEmbedded(`/app/invoices/${sale.id}?${printParams.toString()}`);
}

export default function InvoicePage() {
const {
  staff,
  variants,
  productSearch,
  customers,
  customerSearch,
  existingInvoice,
  embeddedParams,
} = useLoaderData<typeof loader>();

const isEditMode = Boolean(existingInvoice);
const formRef = useRef<HTMLFormElement | null>(null);
const printModeRef = useRef<HTMLInputElement | null>(null);
const customerDetailsRef = useRef<HTMLDivElement | null>(null);
const [showPrintOptions, setShowPrintOptions] = useState(false);
const [isSubmitting, setIsSubmitting] = useState(false);
const [submissionKey] = useState(
  () => `inv-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
);
const shopify = useAppBridge();
const navigation = useNavigation();

// Reset submitting state if navigation returns to idle without navigating away
useEffect(() => {
  if (navigation.state === "idle") {
    setIsSubmitting(false);
  }
}, [navigation.state]);

async function refreshTokenAndSubmit() {
  try {
    const freshToken = await shopify.idToken();
    if (freshToken && formRef.current) {
      // Shopify's middleware reads id_token from the URL, not the POST body.
      // formRef.current.action (DOM property) returns an absolute URL; parse it,
      // update id_token, then set the attribute as a ROOT-RELATIVE path (pathname+search)
      // so React Router resolves it correctly instead of concatenating it onto the
      // current path and producing /app/invoice/https://...
      const actionUrl = new URL(formRef.current.action);
      actionUrl.searchParams.set("id_token", freshToken);
      formRef.current.setAttribute("action", actionUrl.pathname + actionUrl.search);
      // Also update the hidden body field used for building redirect URLs.
      const idTokenInput = formRef.current.querySelector<HTMLInputElement>('input[name="id_token"]');
      if (idTokenInput) idTokenInput.value = freshToken;
    }
  } catch {
    // Continue with existing token if refresh fails
  }
}

async function submitProformaWithPrintMode(mode: "invoice" | "both" | "none") {
  if (isSubmitting) return;
  setShowPrintOptions(false);
  setIsSubmitting(true);
  await refreshTokenAndSubmit();
  if (printModeRef.current) {
    printModeRef.current.value = mode;
  }
  formRef.current?.requestSubmit();
}

async function handleSaveChanges() {
  if (isSubmitting) return;
  setIsSubmitting(true);
  await refreshTokenAndSubmit();
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
  existingInvoice?.vatType || "Standard",
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

const [deliveryAddress1, setDeliveryAddress1] = useState(
  existingInvoice?.deliveryAddress1 || "",
);
const [deliveryAddress2, setDeliveryAddress2] = useState(
  existingInvoice?.deliveryAddress2 || "",
);
const [deliveryCity, setDeliveryCity] = useState(
  existingInvoice?.deliveryCity || "",
);
const [deliveryCounty, setDeliveryCounty] = useState(
  existingInvoice?.deliveryCounty || "",
);
const [deliveryPostcode, setDeliveryPostcode] = useState(
  existingInvoice?.deliveryPostcode || "",
);
const [deliveryCountry, setDeliveryCountry] = useState(
  existingInvoice?.deliveryCountry || "",
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

const [customShippingLabel, setCustomShippingLabel] = useState("");
const [customShippingPrice, setCustomShippingPrice] = useState("0");

const [trackingNumber, setTrackingNumber] = useState(
  existingInvoice?.trackingNumber || "",
);

const [deliveryWorkflowStatus, setDeliveryWorkflowStatus] = useState(
  existingInvoice?.shippingMethod === "Delivery"
    ? (existingInvoice?.deliveryStatus || "Delivery required")
    : "Shipping not required",
);

const [invoiceDiscountEnabled, setInvoiceDiscountEnabled] = useState(
  Boolean(existingInvoice?.invoiceDiscountAmount),
);

const [invoiceDiscountType, setInvoiceDiscountType] = useState(
  existingInvoice?.invoiceDiscountType || "amount",
);

const [invoiceDiscountValue, setInvoiceDiscountValue] = useState(
  String(existingInvoice?.invoiceDiscountValue || 0),
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

const [paymentDate, setPaymentDate] = useState(
  () => new Date().toISOString().slice(0, 16),
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
  { label: "Phone", value: "Phone" },
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

    window.requestAnimationFrame(() => {
      customerDetailsRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    });
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
    const invoiceDiscountBase = roundMoney(Math.max(0, subtotal - discount + shippingCharge));
    const invoiceDiscountAmount = invoiceDiscountEnabled
      ? roundMoney(
          invoiceDiscountType === "percent"
            ? invoiceDiscountBase * (Math.max(0, Number(invoiceDiscountValue || 0)) / 100)
            : Math.min(Math.max(0, Number(invoiceDiscountValue || 0)), invoiceDiscountBase),
        )
      : 0;
    const netTotal = roundMoney(Math.max(0, subtotal - discount + shippingCharge - invoiceDiscountAmount));
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
        invoiceDiscountAmount: 0,
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
      invoiceDiscountAmount,
      paid,
      balanceDue,
      paymentStatus,
    };
  }, [items, vatType, amountPaid, isEditMode, manualTotal, shippingMethod, shippingService, invoiceDiscountEnabled, invoiceDiscountType, invoiceDiscountValue]);

  const deliveryRequiresService = shippingMethod === "Delivery" && !shippingService;

  const validationWarnings = useMemo(() => {
    const warnings: string[] = [];
    if (!customerName.trim()) {
      warnings.push("No customer name — will be saved as 'Walk-in customer'");
    }
    if (items.length === 0 && !(isEditMode && Number(manualTotal) > 0)) {
      warnings.push("No line items have been added to this invoice");
    }
    if (!staffId || staffId === "0") {
      warnings.push("No staff member selected");
    }
    if (totals.total === 0) {
      warnings.push("Invoice total is £0.00");
    }
    return warnings;
  }, [customerName, items.length, staffId, totals.total, isEditMode, manualTotal]);

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
                    {existingInvoice?.id ? (
                      <input type="hidden" name="editInvoiceId" value={String(existingInvoice.id)} />
                    ) : null}
                    <input type="hidden" name="shop" value={embeddedParams.shop || ""} />
                    <input type="hidden" name="host" value={embeddedParams.host || ""} />
                    <input type="hidden" name="embedded" value={embeddedParams.embedded || ""} />

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
                    {existingInvoice?.id ? (
                      <input type="hidden" name="editInvoiceId" value={String(existingInvoice.id)} />
                    ) : null}
                    <input type="hidden" name="shop" value={embeddedParams.shop || ""} />
                    <input type="hidden" name="host" value={embeddedParams.host || ""} />
                    <input type="hidden" name="embedded" value={embeddedParams.embedded || ""} />

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
                      overflowX: "hidden",
                    }}
                  >
                    <IndexTable
                      resourceName={{
                        singular: "product",
                        plural: "products",
                      }}
                      itemCount={variants.length}
                      headings={[
                        { title: "Product" },
                        { title: "Price" },
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
                              <InlineStack gap="300" blockAlign="center">
                                {imageUrl ? (
                                  <img
                                    src={imageUrl}
                                    alt={imageAlt}
                                    style={{
                                      width: 44,
                                      height: 44,
                                      objectFit: "cover",
                                      borderRadius: 8,
                                      border: "1px solid #ddd",
                                      flexShrink: 0,
                                    }}
                                  />
                                ) : (
                                  <div
                                    style={{
                                      width: 44,
                                      height: 44,
                                      borderRadius: 8,
                                      border: "1px solid #ddd",
                                      display: "flex",
                                      alignItems: "center",
                                      justifyContent: "center",
                                      fontSize: 10,
                                      color: "#777",
                                      textAlign: "center",
                                      flexShrink: 0,
                                    }}
                                  >
                                    No image
                                  </div>
                                )}

                                <BlockStack gap="100">
                                  <Text as="span" fontWeight="medium">
                                    {variant.product.title} - {variant.title}
                                  </Text>
                                  <Text as="span" tone="subdued">
                                    SKU: {variant.sku || "-"}
                                  </Text>
                                </BlockStack>
                              </InlineStack>
                            </IndexTable.Cell>

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
        <Form
          method="post"
          ref={formRef}
          onSubmit={() => {
            setIsSubmitting(true);
          }}
        >
          <input type="hidden" name="submissionKey" value={submissionKey} />
          <input
            ref={printModeRef}
            type="hidden"
            name="printMode"
            value={isEditMode ? "none" : "invoice"}
            readOnly
          />
          <input type="hidden" name="lineItems" value={JSON.stringify(items)} />
          <input type="hidden" name="manualTotal" value={manualTotal} />
          <input type="hidden" name="invoiceDiscountEnabled" value={invoiceDiscountEnabled ? "1" : "0"} />
          <input type="hidden" name="invoiceDiscountType" value={invoiceDiscountType} />
          <input type="hidden" name="invoiceDiscountValue" value={invoiceDiscountValue} />
          <input type="hidden" name="customerId" value={customerId} />
          <input type="hidden" name="shop" value={embeddedParams.shop || ""} />
          <input type="hidden" name="host" value={embeddedParams.host || ""} />
          <input type="hidden" name="embedded" value={embeddedParams.embedded || ""} />
          <input type="hidden" name="id_token" value={embeddedParams.id_token || ""} />
          <input
  type="hidden"
  name="editInvoiceId"
  value={existingInvoice?.id || ""}
/>

          <Layout>
            <Layout.Section>
              <BlockStack gap="400">
                <div ref={customerDetailsRef} />
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
                    {showAddress ? "Hide addresses" : "Edit invoice & delivery address"}
                  </Button>

                    {showAddress && (
                      <BlockStack gap="400">
                        <Text as="h3" variant="headingSm">Invoice Address</Text>
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

                        <InlineStack gap="200" blockAlign="center">
                          <Text as="h3" variant="headingSm">Delivery Address</Text>
                          <Button
                            size="slim"
                            onClick={() => {
                              setDeliveryAddress1(address1);
                              setDeliveryAddress2(address2);
                              setDeliveryCity(city);
                              setDeliveryCounty(county);
                              setDeliveryPostcode(postcode);
                              setDeliveryCountry(country);
                            }}
                          >
                            Same as invoice address
                          </Button>
                        </InlineStack>
                        <BlockStack gap="300">
                        <InlineStack gap="300">
                          <div style={{ flex: 1 }}>
                            <TextField
                              label="Address line 1"
                              name="deliveryAddress1"
                              value={deliveryAddress1}
                              onChange={setDeliveryAddress1}
                              autoComplete="off"
                            />
                          </div>
                          <div style={{ flex: 1 }}>
                            <TextField
                              label="Address line 2"
                              name="deliveryAddress2"
                              value={deliveryAddress2}
                              onChange={setDeliveryAddress2}
                              autoComplete="off"
                            />
                          </div>
                        </InlineStack>
                        <InlineStack gap="300">
                          <div style={{ flex: 1 }}>
                            <TextField
                              label="Town / City"
                              name="deliveryCity"
                              value={deliveryCity}
                              onChange={setDeliveryCity}
                              autoComplete="off"
                            />
                          </div>
                          <div style={{ flex: 1 }}>
                            <TextField
                              label="County"
                              name="deliveryCounty"
                              value={deliveryCounty}
                              onChange={setDeliveryCounty}
                              autoComplete="off"
                            />
                          </div>
                        </InlineStack>
                        <InlineStack gap="300">
                          <div style={{ flex: 1 }}>
                            <TextField
                              label="Postcode"
                              name="deliveryPostcode"
                              value={deliveryPostcode}
                              onChange={setDeliveryPostcode}
                              autoComplete="off"
                            />
                          </div>
                          <div style={{ flex: 1 }}>
                            <TextField
                              label="Country"
                              name="deliveryCountry"
                              value={deliveryCountry}
                              onChange={setDeliveryCountry}
                              autoComplete="off"
                              placeholder="United Kingdom"
                            />
                          </div>
                        </InlineStack>
                        </BlockStack>
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
                              setDeliveryWorkflowStatus("Shipping not required");
                            } else {
                              setDeliveryWorkflowStatus("Delivery required");
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
                              { label: "Custom amount / description", value: "custom" },
                            ]}
                            value={shippingService}
                            onChange={setShippingService}
                          />
                        </div>
                      ) : null}

                      {shippingMethod === "Delivery" && shippingService === "custom" ? (
                        <InlineStack gap="200" blockAlign="end">
                          <div style={{ flex: 2 }}>
                            <TextField
                              label="Delivery description"
                              name="customShippingLabel"
                              value={customShippingLabel}
                              onChange={setCustomShippingLabel}
                              autoComplete="off"
                              placeholder="e.g. Express courier"
                            />
                          </div>
                          <div style={{ flex: 1 }}>
                            <TextField
                              label="Amount"
                              name="customShippingPrice"
                              value={customShippingPrice}
                              onChange={setCustomShippingPrice}
                              autoComplete="off"
                              type="number"
                              prefix="£"
                            />
                          </div>
                        </InlineStack>
                      ) : null}

                      {shippingMethod === "Delivery" ? (
                        <div style={{ flex: 1 }}>
                          <Box
                            padding="300"
                            borderWidth="025"
                            borderRadius="200"
                            background={
                              getDeliveryStatusTone(deliveryWorkflowStatus) === "success"
                                ? "bg-fill-success-secondary"
                                : getDeliveryStatusTone(deliveryWorkflowStatus) === "warning"
                                  ? "bg-fill-warning-secondary"
                                  : "bg-fill-critical-secondary"
                            }
                          >
                            <Select
                              label="Delivery workflow"
                              options={DELIVERY_STATUS_OPTIONS.map((option) => ({
                                label: option.label,
                                value: option.value,
                              }))}
                              value={deliveryWorkflowStatus}
                              onChange={setDeliveryWorkflowStatus}
                            />
                          </Box>
                        </div>
                      ) : null}
                    </InlineStack>

                    {shippingMethod === "Delivery" ? (
                      <TextField
                        label="Tracking number"
                        name="trackingNumber"
                        value={trackingNumber}
                        onChange={setTrackingNumber}
                        autoComplete="off"
                        placeholder="Enter courier tracking number"
                      />
                    ) : null}

                    <input
                      type="hidden"
                      name="deliveryWorkflowStatus"
                      value={shippingMethod === "Delivery" ? deliveryWorkflowStatus : "Shipping not required"}
                    />

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
                        <Text as="p">Invoice discount</Text>
                        <Text as="p">-{money(totals.invoiceDiscountAmount || 0)}</Text>
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

                      <InlineStack gap="200" blockAlign="end">
                        <div style={{ flex: 1 }}>
                          <TextField
                            label="Amount paid"
                            name="amountPaid"
                            value={amountPaid}
                            onChange={setAmountPaid}
                            autoComplete="off"
                            type="number"
                            prefix="£"
                          />
                        </div>
                        <Button
                          onClick={() => setAmountPaid(String(totals.total))}
                          disabled={totals.total <= 0}
                        >
                          Pay in full
                        </Button>
                      </InlineStack>

                      <TextField
                        label="Payment date & time"
                        name="paymentDate"
                        value={paymentDate}
                        onChange={setPaymentDate}
                        autoComplete="off"
                        type="datetime-local"
                        helpText="Record the exact date and time of the transaction"
                      />

                      <Button onClick={() => setInvoiceDiscountEnabled((current) => !current)}>
                        {invoiceDiscountEnabled ? "Remove discount" : "Add discount"}
                      </Button>

                      {invoiceDiscountEnabled ? (
                        <BlockStack gap="300">
                          <InlineStack gap="300">
                            <div style={{ flex: 1 }}>
                              <Select
                                label="Discount type"
                                options={[
                                  { label: "Amount off (£)", value: "amount" },
                                  { label: "Percentage off (%)", value: "percent" },
                                ]}
                                value={invoiceDiscountType}
                                onChange={setInvoiceDiscountType}
                              />
                            </div>

                            <div style={{ flex: 1 }}>
                              <TextField
                                label={invoiceDiscountType === "percent" ? "Discount percentage" : "Discount amount"}
                                value={invoiceDiscountValue}
                                onChange={setInvoiceDiscountValue}
                                autoComplete="off"
                                type="number"
                                prefix={invoiceDiscountType === "percent" ? undefined : "£"}
                                suffix={invoiceDiscountType === "percent" ? "%" : undefined}
                              />
                            </div>
                          </InlineStack>

                          <Text as="p" tone="subdued">
                            Discount applied: {money(totals.invoiceDiscountAmount || 0)}
                          </Text>
                        </BlockStack>
                      ) : null}

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

                    {validationWarnings.length > 0 && (
                      <Banner tone="warning">
                        <BlockStack gap="100">
                          <Text as="p" variant="bodyMd" fontWeight="semibold">
                            Issues to review — you can still save and fix later:
                          </Text>
                          {validationWarnings.map((w, i) => (
                            <Text key={i} as="p" variant="bodySm">• {w}</Text>
                          ))}
                        </BlockStack>
                      </Banner>
                    )}

                    {isEditMode ? (
                      <Button variant="primary" fullWidth disabled={deliveryRequiresService || isSubmitting} onClick={handleSaveChanges}>
                        Save Changes
                      </Button>
                    ) : (
                      <Button
                        variant="primary"
                        fullWidth
                        disabled={deliveryRequiresService || isSubmitting}
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
                              disabled={isSubmitting}
                              onClick={() => submitProformaWithPrintMode("invoice")}
                            >
                              Print one sheet (invoice)
                            </Button>

                            <Button disabled={isSubmitting} onClick={() => submitProformaWithPrintMode("both")}>
                              Print two sheets
                            </Button>

                            <Button disabled={isSubmitting} onClick={() => submitProformaWithPrintMode("none")}>
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