import { Form, redirect, useLoaderData, useLocation, useNavigate, useSearchParams } from "react-router";
import type { ActionFunctionArgs } from "react-router";
import { useRef, useState, useEffect, useMemo } from "react";
import {
  AppProvider,
  Page,
  Layout,
  Card,
  Banner,
  Select,
  TextField,
  IndexTable,
  Text,
  Button,
  InlineStack,
  BlockStack,
  Modal,
  Collapsible,
} from "@shopify/polaris";
import "@shopify/polaris/build/esm/styles.css";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getConnectedXeroClient, getXeroConnection, pushNewPaymentsToXero } from "../services/xero.server";
import { createSaleCompat, updateSaleCompat } from "../services/saleCompat.server";
import { getSaleShippingMetaBySaleIds, upsertSaleShippingMeta } from "../services/saleShippingMeta.server";
import { deleteInvoiceWithRelations } from "../services/deleteInvoice.server";

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

function formatDateTime(value: string | Date) {
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "Europe/London",
  }).format(new Date(value));
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

function toSentenceCase(value: string) {
  if (!value) return "-";
  const normalized = value.replace(/_/g, " ").toLowerCase();
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function normalizeDeliveryStatus(shippingMethod: "Collection" | "Delivery", deliveryStatus: string) {
  if (shippingMethod === "Collection") return "Shipping not required";
  const allowed = new Set(["Delivery required", "In progress", "Installation", "Fulfilled"]);
  const value = String(deliveryStatus || "").trim();
  return allowed.has(value) ? value : "Delivery required";
}

function toShopifyOrderGid(value: string | null | undefined) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  if (raw.startsWith("gid://shopify/Order/")) return raw;
  if (/^\d+$/.test(raw)) return `gid://shopify/Order/${raw}`;
  return null;
}

function extractLegacyOrderNumber(value: string | null | undefined) {
  const raw = String(value || "").trim();
  if (!raw) return null;

  const hashMatch = raw.match(/#(\d+)/);
  if (hashMatch?.[1]) return hashMatch[1];

  if (/^\d+$/.test(raw)) return raw;
  return null;
}

function normalizeText(value: unknown) {
  return String(value || "").trim().toLowerCase();
}

function roundToPennies(value: unknown) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function lineItemsSignature(lineItems: Array<any>) {
  return [...lineItems]
    .map((item) => ({
      title: normalizeText(item.title),
      sku: normalizeText(item.sku),
      quantity: Number(item.quantity || 0),
      unitPrice: roundToPennies(item.unitPrice),
      discount: roundToPennies(item.discount),
      isCustom: Boolean(item.isCustom),
    }))
    .sort((a, b) =>
      `${a.title}|${a.sku}|${a.quantity}|${a.unitPrice}|${a.discount}|${a.isCustom}`
        .localeCompare(`${b.title}|${b.sku}|${b.quantity}|${b.unitPrice}|${b.discount}|${b.isCustom}`),
    )
    .map((item) => `${item.title}|${item.sku}|${item.quantity}|${item.unitPrice}|${item.discount}|${item.isCustom}`)
    .join("||");
}

function invoiceDuplicateSignature(invoice: any) {
  return [
    normalizeText(invoice.customerName),
    roundToPennies(invoice.total),
    normalizeText(invoice.paymentMethod),
    Number(invoice.staffId || 0),
    normalizeText(invoice.reference),
    lineItemsSignature(invoice.lineItems || []),
  ].join("__");
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

export async function action({ request }: ActionFunctionArgs) {
  const { admin } = await authenticate.admin(request);

  const formData = await request.formData();
  const intent = String(formData.get("_intent") || "");

  if (intent === "openShopifyLegacyInEditor") {
    const shopifyOrderId = String(formData.get("shopifyOrderId") || "").trim();
    const legacyResourceId = String(formData.get("legacyResourceId") || "").trim();
    const openMode = String(formData.get("openMode") || "edit").trim().toLowerCase();
    const viewPathForSale = (saleId: number) =>
      openMode === "view" ? `/app/invoices/${saleId}` : `/app/invoice?editInvoiceId=${saleId}`;

    if (!shopifyOrderId) {
      return redirect(
        withEmbeddedParamsFromRequest(
          request,
          "/app/invoices?syncStatus=error&syncMessage=Invalid%20Shopify%20invoice%20selection",
        ),
      );
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
        return redirect(withEmbeddedParamsFromRequest(request, viewPathForSale(existingSale.id)));
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
        return redirect(
          withEmbeddedParamsFromRequest(
            request,
            "/app/invoices?syncStatus=error&syncMessage=Shopify%20invoice%20order%20not%20found",
          ),
        );
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
        return redirect(
          withEmbeddedParamsFromRequest(
            request,
            "/app/invoices?syncStatus=error&syncMessage=No%20staff%20record%20exists",
          ),
        );
      }

      const total = toNumber(order?.currentTotalPriceSet?.shopMoney?.amount);
      const amountPaid = parseMoneyString(getCustomAttributeValue(customAttributes, "Amount Paid"));
      const paymentMethod = getCustomAttributeValue(customAttributes, "Payment Method") || "Other";
      const depositPaidAttr = getCustomAttributeValue(customAttributes, "Deposit Paid").toLowerCase();
      const depositPaid = depositPaidAttr === "yes" || (amountPaid > 0 && amountPaid < total);

      const createdSale = await createSaleCompat({
        sale: {
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
        },
          lineItems: (order.lineItems?.edges || []).map((edge: any) => {
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
      });

      return redirect(withEmbeddedParamsFromRequest(request, viewPathForSale(createdSale.id)));
    } catch (error: any) {
      console.error("Failed to open Shopify legacy invoice in editor:", error);
      const message = encodeURIComponent(String(error?.message || "Failed to open Shopify legacy invoice"));
      return redirect(
        withEmbeddedParamsFromRequest(request, `/app/invoices?syncStatus=error&syncMessage=${message}`),
      );
    }
  }

  if (intent === "deleteInvoice") {
    const invoiceId = Number(formData.get("invoiceId") || 0);

    if (!invoiceId) {
      return redirect(
        withEmbeddedParamsFromRequest(
          request,
          "/app/invoices?syncStatus=error&syncMessage=Invalid%20invoice%20selected%20for%20deletion",
        ),
      );
    }

    try {
      await deleteInvoiceWithRelations(invoiceId);
      return redirect(
        withEmbeddedParamsFromRequest(
          request,
          `/app/invoices?syncStatus=success&syncMessage=${encodeURIComponent(`Deleted invoice INV-${invoiceId}`)}`,
        ),
      );
    } catch (error: any) {
      console.error("Failed to delete invoice:", error);
      const message = encodeURIComponent(String(error?.message || "Failed to delete invoice"));
      return redirect(withEmbeddedParamsFromRequest(request, `/app/invoices?syncStatus=error&syncMessage=${message}`));
    }
  }

  if (intent === "updateShippingMeta") {
    const invoiceId = Number(formData.get("invoiceId") || 0);
    const nextShippingMethod =
      String(formData.get("shippingMethod") || "Collection") === "Delivery"
        ? "Delivery"
        : "Collection";
    const nextDeliveryStatus = normalizeDeliveryStatus(
      nextShippingMethod,
      String(formData.get("deliveryStatus") || ""),
    );
    const nextTrackingNumberRaw = String(formData.get("trackingNumber") || "").trim();
    const nextTrackingNumber = nextShippingMethod === "Delivery" ? nextTrackingNumberRaw : "";

    if (!invoiceId) {
      return redirect(
        withEmbeddedParamsFromRequest(
          request,
          "/app/invoices?syncStatus=error&syncMessage=Invalid%20invoice%20selected%20for%20shipping%20update",
        ),
      );
    }

    try {
      const [existingMeta, sale] = await Promise.all([
        getSaleShippingMetaBySaleIds([invoiceId]),
        prisma.sale.findUnique({
          where: { id: invoiceId },
          select: { shopifyOrderId: true },
        }),
      ]);
      const currentMeta = existingMeta.get(invoiceId);

      await upsertSaleShippingMeta({
        saleId: invoiceId,
        shippingMethod: nextShippingMethod,
        deliveryStatus: nextDeliveryStatus,
        trackingNumber: nextTrackingNumber || null,
        trackingUrl: nextTrackingNumber ? currentMeta?.trackingUrl || null : null,
        carrierName: currentMeta?.carrierName || null,
        deliveryMethod:
          nextShippingMethod === "Delivery"
            ? currentMeta?.deliveryMethod || "Delivery"
            : "Shipping not required",
        fulfillmentStatus:
          nextShippingMethod === "Collection"
            ? "Fulfilled"
            : nextDeliveryStatus === "Fulfilled"
              ? "Fulfilled"
              : "Unfulfilled",
      });

      let shopifySyncFailed = false;
      const orderGid = toShopifyOrderGid(sale?.shopifyOrderId || null);

      if (orderGid) {
        try {
          const readOrderResponse = await admin.graphql(
            `
              query ReadOrderForShippingSync($id: ID!) {
                order(id: $id) {
                  id
                  tags
                  customAttributes {
                    key
                    value
                  }
                }
              }
            `,
            { variables: { id: orderGid } },
          );

          const readOrderJson = (await readOrderResponse.json()) as any;
          const order = readOrderJson?.data?.order;

          if (order?.id) {
            const existingAttributes = Array.isArray(order.customAttributes)
              ? order.customAttributes
              : [];
            const attrMap = new Map<string, string>();

            for (const attr of existingAttributes) {
              const key = String(attr?.key || "").trim();
              if (!key) continue;
              attrMap.set(key, String(attr?.value || ""));
            }

            attrMap.set("Order Type", nextShippingMethod === "Delivery" ? "Delivery" : "Collected");
            attrMap.set("Shipping Service", nextShippingMethod === "Delivery" ? currentMeta?.deliveryMethod || "Delivery" : "Shipping not required");
            attrMap.set("Delivery Workflow", nextDeliveryStatus);
            attrMap.set("Tracking Number", nextTrackingNumber || "-");

            const syncAttributes = Array.from(attrMap.entries()).map(([key, value]) => ({ key, value }));

            const existingTags = Array.isArray(order.tags)
              ? order.tags.map((tag: any) => String(tag || "").trim()).filter(Boolean)
              : [];

            const tagsToRemove = new Set([
              "delivery",
              "collection",
              "collected",
              "delivery-required",
              "in-progress",
              "fulfilled",
              "shipping-not-required",
            ]);

            const keptTags = existingTags.filter((tag: string) => !tagsToRemove.has(tag.toLowerCase()));
            const rawSyncTags = [
              ...keptTags,
              nextShippingMethod.toLowerCase(),
              nextDeliveryStatus.toLowerCase().replace(/\s+/g, "-"),
            ];
            // Sanitize: Shopify rejects tags that are empty, contain commas,
            // or exceed 40 characters — dedupe to avoid unnecessary rejects too.
            const syncTags = Array.from(
              new Set(
                rawSyncTags
                  .map((tag) =>
                    String(tag || "")
                      .replace(/[(),\[\]{}!@#$%^&*+=<>?\\|"~`]/g, "") // strip chars Shopify rejects
                      .replace(/\s+/g, " ")
                      .trim()
                      .slice(0, 40)
                  )
                  .filter(Boolean),
              ),
            );

            const updateOrderResponse = await admin.graphql(
              `
                mutation UpdateOrderShippingMeta($input: OrderInput!) {
                  orderUpdate(input: $input) {
                    order {
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
                    id: order.id,
                    customAttributes: syncAttributes,
                    tags: syncTags,
                  },
                },
              },
            );

            const updateOrderJson = (await updateOrderResponse.json()) as any;
            const updateErrors = updateOrderJson?.data?.orderUpdate?.userErrors || [];
            if (updateErrors.length > 0) {
              shopifySyncFailed = true;
              console.error("Failed syncing shipping to Shopify order:", updateErrors, "tags sent:", syncTags);
            }
          }
        } catch (shopifyError) {
          shopifySyncFailed = true;
          console.error("Shopify order shipping sync failed:", shopifyError);
        }
      }

      return redirect(
        withEmbeddedParamsFromRequest(
          request,
          `/app/invoices?syncStatus=${shopifySyncFailed ? "warning" : "success"}&syncMessage=${encodeURIComponent(
            shopifySyncFailed
              ? `Updated shipping for INV-${invoiceId}, but Shopify order sync failed`
              : `Updated shipping for INV-${invoiceId}`,
          )}`,
        ),
      );
    } catch (error: any) {
      console.error("Failed to update shipping meta:", error);
      const message = encodeURIComponent(String(error?.message || "Failed to update shipping"));
      return redirect(withEmbeddedParamsFromRequest(request, `/app/invoices?syncStatus=error&syncMessage=${message}`));
    }
  }

  if (intent === "openLegacyInEditor") {
    const worksOrderId = Number(formData.get("worksOrderId") || 0);

    if (!worksOrderId) {
      return redirect(
        withEmbeddedParamsFromRequest(
          request,
          "/app/invoices?syncStatus=error&syncMessage=Invalid%20legacy%20invoice%20selection",
        ),
      );
    }

    try {
      const reference = `WORKS:${worksOrderId}`;

      const existingSale = await prisma.sale.findFirst({
        where: { reference },
        select: { id: true },
      });

      if (existingSale) {
        return redirect(withEmbeddedParamsFromRequest(request, `/app/invoice?editInvoiceId=${existingSale.id}`));
      }

      const worksOrder = await prisma.worksOrder.findUnique({
        where: { id: worksOrderId },
        include: { lineItems: true },
      });

      if (!worksOrder) {
        return redirect(
          withEmbeddedParamsFromRequest(
            request,
            "/app/invoices?syncStatus=error&syncMessage=Legacy%20invoice%20not%20found",
          ),
        );
      }

      const defaultStaff = await prisma.staff.findFirst({ orderBy: { id: "asc" } });
      const staffExists = worksOrder.salespersonId
        ? await prisma.staff.findUnique({
            where: { id: worksOrder.salespersonId },
            select: { id: true },
          })
        : null;

      if (!defaultStaff && !staffExists) {
        return redirect(
          withEmbeddedParamsFromRequest(
            request,
            "/app/invoices?syncStatus=error&syncMessage=No%20staff%20record%20exists",
          ),
        );
      }

      const total = Number(worksOrder.total ?? 0);
      const amountPaid = Number(worksOrder.amountPaid ?? 0);

      const createdSale = await createSaleCompat({
        sale: {
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
        },
          lineItems: worksOrder.lineItems.map((item) => ({
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
      });

      return redirect(withEmbeddedParamsFromRequest(request, `/app/invoice?editInvoiceId=${createdSale.id}`));
    } catch (error: any) {
      console.error("Failed to open legacy invoice in editor:", error);
      const message = encodeURIComponent(String(error?.message || "Failed to open legacy invoice"));
      return redirect(
        withEmbeddedParamsFromRequest(request, `/app/invoices?syncStatus=error&syncMessage=${message}`),
      );
    }
  }

  if (intent === "backfillNcpNumbers") {
    try {
      const response = await admin.graphql(
        `
          query BackfillLegacyInvoiceOrders($query: String!) {
            orders(first: 100, query: $query, reverse: true, sortKey: CREATED_AT) {
              edges {
                node {
                  id
                  name
                  createdAt
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
      const shopifyOrders =
        json?.data?.orders?.edges?.map((edge: any) => ({
          id: String(edge?.node?.id || ""),
          name: String(edge?.node?.name || ""),
          createdAt: new Date(String(edge?.node?.createdAt || new Date().toISOString())),
          customerName: String(edge?.node?.customer?.displayName || "").trim().toLowerCase(),
          total: Number(edge?.node?.currentTotalPriceSet?.shopMoney?.amount ?? 0),
        })) || [];

      const localInvoices = await prisma.sale.findMany({
        where: {
          OR: [{ shopifyOrderId: null }, { shopifyOrderName: null }],
        },
        select: {
          id: true,
          customerName: true,
          total: true,
          createdAt: true,
          shopifyOrderId: true,
          shopifyOrderName: true,
        },
      });

      let updatedCount = 0;

      for (const invoice of localInvoices) {
        const invoiceCustomerName = String(invoice.customerName || "").trim().toLowerCase();
        const invoiceTotal = Number(invoice.total || 0);

        const candidates = shopifyOrders
          .filter((order: any) => {
            const sameCustomer = order.customerName === invoiceCustomerName;
            const sameTotal = Math.abs(Number(order.total || 0) - invoiceTotal) < 0.01;
            return sameCustomer && sameTotal;
          })
          .sort(
            (a: any, b: any) =>
              Math.abs(a.createdAt.getTime() - new Date(invoice.createdAt).getTime()) -
              Math.abs(b.createdAt.getTime() - new Date(invoice.createdAt).getTime()),
          );

        const bestMatch = candidates[0];
        if (!bestMatch) continue;

        await updateSaleCompat({
          saleId: invoice.id,
          sale: {
            shopifyOrderId: invoice.shopifyOrderId || bestMatch.id,
            shopifyOrderName: invoice.shopifyOrderName || bestMatch.name,
          },
        });

        updatedCount += 1;
      }

      return redirect(
        withEmbeddedParamsFromRequest(
          request,
          `/app/invoices?syncStatus=success&syncMessage=Recovered%20NCP%20numbers%20for%20${updatedCount}%20invoice(s)`,
        ),
      );
    } catch (error: any) {
      console.error("Failed to backfill NCP numbers:", error);
      const message = encodeURIComponent(String(error?.message || "Failed to recover NCP numbers"));
      return redirect(withEmbeddedParamsFromRequest(request, `/app/invoices?syncStatus=error&syncMessage=${message}`));
    }
  }

  if (intent === "pullShippingFromShopify") {
    try {
      const sales = await prisma.sale.findMany({
        where: {
          OR: [
            {
              shopifyOrderId: {
                not: null,
              },
            },
            {
              reference: {
                startsWith: "SHOPIFY:",
              },
            },
            {
              shopifyOrderName: {
                not: null,
              },
            },
          ],
        },
        select: {
          id: true,
          shopifyOrderId: true,
          shopifyOrderName: true,
          reference: true,
          customerName: true,
          total: true,
          createdAt: true,
        },
        orderBy: { createdAt: "desc" },
        take: 500,
      });

      const orderLookupResponse = await admin.graphql(
        `
          query ShippingOrderLookup {
            orders(first: 250, reverse: true, sortKey: CREATED_AT) {
              edges {
                node {
                  id
                  name
                  legacyResourceId
                  createdAt
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
      );

      const orderLookupJson = (await orderLookupResponse.json()) as any;
      const lookupOrders =
        orderLookupJson?.data?.orders?.edges?.map((edge: any) => ({
          id: String(edge?.node?.id || "").trim(),
          name: String(edge?.node?.name || "").trim(),
          legacyResourceId: String(edge?.node?.legacyResourceId || "").trim(),
          createdAt: new Date(String(edge?.node?.createdAt || new Date().toISOString())),
          customerName: String(edge?.node?.customer?.displayName || "").trim().toLowerCase(),
          total: Number(edge?.node?.currentTotalPriceSet?.shopMoney?.amount ?? 0),
        })) || [];

      const orderIdByName = new Map<string, string>();
      const orderIdByLegacyNumber = new Map<string, string>();

      for (const order of lookupOrders) {
        if (order.name && order.id) {
          orderIdByName.set(order.name.toLowerCase(), order.id);
        }
        if (order.legacyResourceId && order.id) {
          orderIdByLegacyNumber.set(order.legacyResourceId, order.id);
        }
      }

      let updatedCount = 0;
      let unresolvedCount = 0;
      let missingInShopifyCount = 0;
      let erroredCount = 0;

      const pullOrderShippingQuery = `
        query PullOrderShipping($id: ID!) {
          order(id: $id) {
            id
            tags
            displayFulfillmentStatus
            customAttributes {
              key
              value
            }
            shippingAddress {
              address1
            }
            fulfillments(first: 10) {
              nodes {
                trackingInfo {
                  number
                  company
                  url
                }
              }
            }
          }
        }
      `;

      const pullOrderShippingFallbackQuery = `
        query PullOrderShippingFallback($id: ID!) {
          order(id: $id) {
            id
            tags
            shippingAddress {
              address1
            }
          }
        }
      `;

      for (const sale of sales) {
        const referenceValue = String(sale.reference || "").trim();
        const referenceOrderId = referenceValue.startsWith("SHOPIFY:")
          ? referenceValue.replace(/^SHOPIFY:/, "").trim()
          : "";
        const fromDirectId =
          toShopifyOrderGid(String(sale.shopifyOrderId || "").trim()) ||
          toShopifyOrderGid(referenceOrderId);
        const saleOrderName = String(sale.shopifyOrderName || "").trim();
        const nameMatchId = saleOrderName ? orderIdByName.get(saleOrderName.toLowerCase()) || null : null;
        const legacyFromName = extractLegacyOrderNumber(saleOrderName);
        const legacyFromReference = extractLegacyOrderNumber(referenceOrderId);
        const legacyMatchId =
          (legacyFromName ? orderIdByLegacyNumber.get(legacyFromName) : null) ||
          (legacyFromReference ? orderIdByLegacyNumber.get(legacyFromReference) : null) ||
          null;

        const saleCustomerName = String(sale.customerName || "").trim().toLowerCase();
        const saleTotal = Number(sale.total || 0);
        const closestByCustomerAndTotal = lookupOrders
          .filter((order: any) => {
            if (!order.id) return false;
            if (!saleCustomerName || !order.customerName) return false;
            if (saleCustomerName !== order.customerName) return false;
            return Math.abs(Number(order.total || 0) - saleTotal) < 0.01;
          })
          .sort(
            (a: any, b: any) =>
              Math.abs(new Date(a.createdAt).getTime() - new Date(sale.createdAt).getTime()) -
              Math.abs(new Date(b.createdAt).getTime() - new Date(sale.createdAt).getTime()),
          )[0]?.id || null;

        const orderId = fromDirectId || nameMatchId || legacyMatchId || closestByCustomerAndTotal;
        if (!orderId) {
          unresolvedCount += 1;
          continue;
        }

        try {
          let order: any = null;
          let usedFallbackQuery = false;

          try {
            const response = await admin.graphql(pullOrderShippingQuery, {
              variables: { id: orderId },
            });
            const json = (await response.json()) as any;
            order = json?.data?.order;
          } catch (primaryQueryError) {
            // Some stores/scopes reject newer order fields; fallback keeps shipping sync working.
            console.error(`Primary shipping query failed for sale ${sale.id}, retrying with fallback fields:`, primaryQueryError);

            const fallbackResponse = await admin.graphql(pullOrderShippingFallbackQuery, {
              variables: { id: orderId },
            });
            const fallbackJson = (await fallbackResponse.json()) as any;
            order = fallbackJson?.data?.order;
            usedFallbackQuery = true;
          }

          if (!order) {
            missingInShopifyCount += 1;
            continue;
          }

          const orderType = usedFallbackQuery
            ? ""
            : getCustomAttributeValue(order.customAttributes || [], "Order Type");
          const normalizedOrderType = String(orderType || "").trim().toLowerCase();
          const orderTags = Array.isArray(order?.tags)
            ? order.tags.map((tag: any) => String(tag || "").trim().toLowerCase())
            : [];

          let shippingMethod: "Collection" | "Delivery" = "Collection";

          if (normalizedOrderType === "delivery" || orderTags.includes("delivery")) {
            shippingMethod = "Delivery";
          } else if (orderTags.includes("collected") || orderTags.includes("collection")) {
            shippingMethod = "Collection";
          } else if (!normalizedOrderType && order?.shippingAddress?.address1) {
            // Fallback when older orders don't have Order Type custom attribute.
            shippingMethod = "Delivery";
          }

          const firstTracking = usedFallbackQuery
            ? null
            : order?.fulfillments?.nodes
                ?.flatMap((fulfillment: any) => fulfillment?.trackingInfo || [])
                ?.find((tracking: any) => String(tracking?.number || "").trim());
          const trackingNumber = firstTracking ? String(firstTracking?.number || "").trim() || null : null;
          const carrierName = firstTracking ? String(firstTracking?.company || "").trim() || null : null;
          const trackingUrl = firstTracking ? String(firstTracking?.url || "").trim() || null : null;

          const hasTracking = Boolean(trackingNumber);
          const deliveryMethod =
            shippingMethod === "Collection"
              ? "Shipping not required"
              : usedFallbackQuery
                ? "Delivery"
                : "Standard Delivery";
          const fulfillmentStatus = usedFallbackQuery
            ? "-"
            : toSentenceCase(String(order?.displayFulfillmentStatus || ""));
          const deliveryStatus =
            shippingMethod === "Collection"
              ? "Shipping not required"
              : hasTracking
                ? "Tracking added"
                : usedFallbackQuery
                  ? "Awaiting shipment update"
                  : "Awaiting tracking";

          await upsertSaleShippingMeta({
            saleId: sale.id,
            shippingMethod,
            trackingNumber,
            trackingUrl,
            carrierName,
            fulfillmentStatus,
            deliveryStatus,
            deliveryMethod,
          });

          updatedCount += 1;
        } catch (error) {
          erroredCount += 1;
          console.error(`Failed pulling shipping for sale ${sale.id}:`, error);
        }
      }

      const syncSummary = encodeURIComponent(
        `Pulled shipping details for ${updatedCount} invoice(s). Unresolved: ${unresolvedCount}, Missing in Shopify: ${missingInShopifyCount}, Errors: ${erroredCount}`,
      );

      return redirect(
        withEmbeddedParamsFromRequest(
          request,
          `/app/invoices?syncStatus=success&syncMessage=${syncSummary}`,
        ),
      );
    } catch (error: any) {
      console.error("Failed to pull shipping from Shopify:", error);
      const message = encodeURIComponent(String(error?.message || "Failed to pull shipping from Shopify"));
      return redirect(withEmbeddedParamsFromRequest(request, `/app/invoices?syncStatus=error&syncMessage=${message}`));
    }
  }

  if (intent === "deleteDuplicateInvoices") {
    try {
      const candidates = await prisma.sale.findMany({
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          customerName: true,
          total: true,
          paymentMethod: true,
          staffId: true,
          reference: true,
          createdAt: true,
          lineItems: {
            select: {
              title: true,
              sku: true,
              quantity: true,
              unitPrice: true,
              discount: true,
              isCustom: true,
            },
          },
        },
      });

      const groups = new Map<string, Array<any>>();
      for (const invoice of candidates) {
        const key = invoiceDuplicateSignature(invoice);
        const list = groups.get(key) || [];
        list.push(invoice);
        groups.set(key, list);
      }

      const duplicateIds: number[] = [];
      const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;

      for (const invoices of groups.values()) {
        if (invoices.length < 2) continue;

        const sorted = [...invoices].sort(
          (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
        );

        let keeper = sorted[0];

        for (let i = 1; i < sorted.length; i += 1) {
          const current = sorted[i];
          const delta = Math.abs(
            new Date(current.createdAt).getTime() - new Date(keeper.createdAt).getTime(),
          );

          if (delta <= DUPLICATE_WINDOW_MS) {
            duplicateIds.push(current.id);
          } else {
            keeper = current;
          }
        }
      }

      if (!duplicateIds.length) {
        return redirect(
          withEmbeddedParamsFromRequest(
            request,
            "/app/invoices?syncStatus=success&syncMessage=No%20duplicate%20invoices%20found",
          ),
        );
      }

      let skippedPaymentCleanup = false;

      try {
        await prisma.payment.deleteMany({ where: { saleId: { in: duplicateIds } } });
      } catch (error: any) {
        const message = String(error?.message || "");
        const missingPaymentTable =
          message.includes('The table `public.Payment` does not exist') ||
          (message.toLowerCase().includes("table") && message.includes("Payment") && message.toLowerCase().includes("does not exist"));

        if (missingPaymentTable) {
          skippedPaymentCleanup = true;
          console.warn("Skipping payment cleanup because Payment table is missing.");
        } else {
          throw error;
        }
      }

      await prisma.$transaction([
        prisma.saleLineItem.deleteMany({ where: { saleId: { in: duplicateIds } } }),
        prisma.sale.deleteMany({ where: { id: { in: duplicateIds } } }),
      ]);

      return redirect(
        withEmbeddedParamsFromRequest(
          request,
          `/app/invoices?syncStatus=success&syncMessage=${encodeURIComponent(
            `Deleted ${duplicateIds.length} duplicate invoice(s)${skippedPaymentCleanup ? " (payment cleanup skipped on legacy database)" : ""}`,
          )}`,
        ),
      );
    } catch (error: any) {
      console.error("Failed to delete duplicate invoices:", error);
      const message = encodeURIComponent(String(error?.message || "Failed to delete duplicate invoices"));
      return redirect(withEmbeddedParamsFromRequest(request, `/app/invoices?syncStatus=error&syncMessage=${message}`));
    }
  }

  if (intent === "emailInvoice") {
    const invoiceId = Number(formData.get("invoiceId"));
    if (!invoiceId) return redirect(withEmbeddedParamsFromRequest(request, `/app/invoices?syncStatus=error&syncMessage=${encodeURIComponent("Invalid invoice ID")}`));
    const sale = await prisma.sale.findUnique({
      where: { id: invoiceId },
      select: { customerEmail: true, customerName: true, paymentStatus: true },
    });
    if (!sale?.customerEmail) {
      return redirect(withEmbeddedParamsFromRequest(request, `/app/invoices?syncStatus=error&syncMessage=${encodeURIComponent(`INV-${invoiceId}: no customer email on file`)}`));
    }
    const { email: recipientEmail, name: recipientName, status: paymentStatus } =
      { email: sale.customerEmail, name: sale.customerName || "", status: sale.paymentStatus || "Unpaid" };
    // Fire-and-forget — PDF generation (Puppeteer) + SMTP can take 10-30s.
    // Awaiting them here blocks the redirect and causes Railway request timeouts.
    (async () => {
      try {
        const { generateInvoicePdf } = await import("../utils/invoice-pdf.server");
        const { sendInvoiceEmail } = await import("../utils/email.server");
        const pdfBuffer = await generateInvoicePdf(invoiceId);
        await sendInvoiceEmail({
          to: recipientEmail,
          customerName: recipientName,
          invoiceId,
          pdfBuffer,
          paymentStatus: paymentStatus,
        });
        console.log(`[email] Invoice INV-${invoiceId} emailed to ${recipientEmail}`);
      } catch (err: any) {
        console.error(`[email] Invoice INV-${invoiceId} failed:`, err);
      }
    })();
    return redirect(withEmbeddedParamsFromRequest(request, `/app/invoices?syncStatus=emailSent&syncMessage=${encodeURIComponent(`Invoice INV-${invoiceId} emailed to ${recipientEmail}`)}`));
  }

  if (intent === "pushUnsentToXero") {
    try {
      // Step 1: Connect to Xero
      let xeroClient: Awaited<ReturnType<typeof getConnectedXeroClient>>;
      try {
        xeroClient = await getConnectedXeroClient();
      } catch {
        return redirect(withEmbeddedParamsFromRequest(request, `/app/invoices?syncStatus=error&syncMessage=${encodeURIComponent("Xero is not connected. Connect Xero first.")}`));
      }
      const { xero, tenantId } = xeroClient;

      // Step 2: Find up to 50 sales with unpushed payments
      const unpushedSales = await prisma.$queryRaw<Array<{ id: number }>>`
        SELECT DISTINCT s.id FROM "Sale" s
        JOIN "Payment" p ON p."saleId" = s.id
          AND (p."xeroInvoiceId" IS NULL
            OR (p."xeroInvoiceId" = 'PENDING' AND p."createdAt" < NOW() - INTERVAL '10 minutes'))
        WHERE (s."xeroInvoiceId" IS NULL)
          AND (s."shopifyOrderId" IS NULL OR s."shopifyOrderId" NOT LIKE 'xero:%')
        ORDER BY s.id DESC
        LIMIT 50
      `;

      if (unpushedSales.length === 0) {
        return redirect(withEmbeddedParamsFromRequest(request, `/app/invoices?syncStatus=success&syncMessage=${encodeURIComponent("All invoices are already in Xero")}`));
      }

      // Step 3: Pre-fetch existing Xero invoices to cross-reference against the old
      // Shopify connector. The old connector didn't use the .1 suffix — it likely used
      // the Shopify order name (e.g. NCP#1638) as the invoice reference or number.
      // We build a lookup: normalised (reference | invoiceNumber) → { invoiceID, total }
      // so we can link rather than duplicate any invoice the old connector already sent.
      type XeroSummary = { invoiceID: string; total: number };
      const xeroLookup = new Map<string, XeroSummary>();
      try {
        let page = 1;
        while (page <= 10) { // max 1 000 invoices
          const resp = await (xero.accountingApi as any).getInvoices(
            tenantId,
            undefined,                          // ifModifiedSince
            'Type=="ACCREC" AND Status!="VOIDED"', // where
            undefined,                          // order
            undefined,                          // IDs
            undefined,                          // invoiceNumbers
            undefined,                          // contactIDs
            undefined,                          // statuses
            page,                               // page (100 per page)
            false,                              // includeArchived
            false,                              // createdByMyApp
            undefined,                          // unitdp
            true,                               // summaryOnly — faster, key fields only
          );
          const invoices: any[] = resp?.body?.invoices || [];
          if (invoices.length === 0) break;
          for (const inv of invoices) {
            const entry: XeroSummary = { invoiceID: String(inv.invoiceID || ""), total: Number(inv.total || 0) };
            // Index by reference (what the old Shopify connector typically sets to the order name)
            if (inv.reference) xeroLookup.set(String(inv.reference).toLowerCase().trim(), entry);
            // Index by invoiceNumber (some connectors use the order name here)
            if (inv.invoiceNumber) xeroLookup.set(String(inv.invoiceNumber).toLowerCase().trim(), entry);
          }
          if (invoices.length < 100) break; // last page
          page++;
        }
        console.log(`[pushUnsentToXero] Pre-fetched ${xeroLookup.size} Xero invoice keys for duplicate check`);
      } catch (err: any) {
        // If pre-fetch fails, log but continue — we'll push rather than silently skip
        console.error("[pushUnsentToXero] Could not pre-fetch Xero invoices for duplicate check:", err?.message || err);
      }

      // Step 4: For each sale, check lookup then push or link
      let pushed = 0;
      let linked = 0;  // already existed in Xero from old connector — linked, not duplicated
      let failed = 0;
      let firstError: string | null = null;

      for (const { id } of unpushedSales) {
        // Load the sale's order name and total for matching
        let shopifyOrderName: string | null = null;
        let saleTotal = 0;
        try {
          const row = await prisma.sale.findUnique({
            where: { id },
            select: { shopifyOrderName: true, reference: true, total: true },
          });
          shopifyOrderName = row?.shopifyOrderName || row?.reference || null;
          saleTotal = Number(row?.total || 0);
        } catch { /* keep defaults */ }

        // Cross-reference: look for a Xero invoice where the reference or invoice
        // number matches our Shopify order name AND the total is within £1.
        let existingXeroId: string | null = null;
        if (shopifyOrderName && xeroLookup.size > 0) {
          const key = shopifyOrderName.toLowerCase().trim();
          const match = xeroLookup.get(key);
          if (match && match.invoiceID && Math.abs(match.total - saleTotal) <= 1.0) {
            existingXeroId = match.invoiceID;
          }
        }

        if (existingXeroId) {
          // Already in Xero from old connector — link it without creating a duplicate
          try {
            await prisma.$executeRaw`
              UPDATE "Payment" SET "xeroInvoiceId" = ${existingXeroId}
              WHERE "saleId" = ${id}
                AND ("xeroInvoiceId" IS NULL OR "xeroInvoiceId" = 'PENDING')
            `;
            await prisma.$executeRaw`UPDATE "Sale" SET "xeroInvoiceId" = ${existingXeroId} WHERE id = ${id}`;
            linked++;
            console.log(`[pushUnsentToXero] sale ${id} already in Xero as ${existingXeroId} — linked`);
          } catch {
            failed++;
          }
        } else {
          // Not in Xero yet — push it
          try {
            const result = await pushNewPaymentsToXero(id);
            if (result.pushed > 0) {
              pushed++;
            } else {
              failed++;
              if (result.lastError && !firstError) firstError = `Invoice ${id}: ${result.lastError}`;
            }
          } catch (err: any) {
            failed++;
            if (!firstError) firstError = String(err?.message || err);
          }
        }
      }

      const parts: string[] = [];
      if (pushed > 0) parts.push(`Pushed ${pushed} new invoice(s) to Xero`);
      if (linked > 0) parts.push(`${linked} already existed in Xero from previous connector — linked (no duplicates created)`);
      if (failed > 0) parts.push(`${failed} failed${firstError ? `: ${firstError}` : " — check Railway logs"}`);
      const message = parts.join(". ") || "Done";
      const syncStatus = failed > 0 && pushed === 0 && linked === 0 ? "error" : "success";
      return redirect(withEmbeddedParamsFromRequest(request, `/app/invoices?syncStatus=${syncStatus}&syncMessage=${encodeURIComponent(message)}`));
    } catch (error: any) {
      const message = encodeURIComponent(String(error?.message || "Failed to push to Xero"));
      return redirect(withEmbeddedParamsFromRequest(request, `/app/invoices?syncStatus=error&syncMessage=${message}`));
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
        withEmbeddedParamsFromRequest(
          request,
          "/app/invoices?syncStatus=error&syncMessage=Xero%20is%20not%20connected%20yet&connectXero=1",
        ),
      );
    }

    const { xero, tenantId } = await getConnectedXeroClient();

    if (!defaultStaff) {
      return redirect(
        withEmbeddedParamsFromRequest(
          request,
          "/app/invoices?syncStatus=error&syncMessage=No%20staff%20record%20exists",
        ),
      );
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

      await createSaleCompat({
        sale: {
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

    return redirect(
      withEmbeddedParamsFromRequest(
        request,
        `/app/invoices?syncStatus=success&syncMessage=Imported%20${importedCount}%20Xero%20invoice(s)`,
      ),
    );
  } catch (error: any) {
    console.error("Failed to sync Xero invoices:", error);
    const message = encodeURIComponent(String(error?.message || "Xero sync failed"));
    return redirect(withEmbeddedParamsFromRequest(request, `/app/invoices?syncStatus=error&syncMessage=${message}`));
  }
}

export async function loader({ request }: { request: Request }) {
  try {
    const { admin } = await authenticate.admin(request);

    const url = new URL(request.url);
    const query = String(url.searchParams.get("query") || "").trim();
    const paymentFilter = String(url.searchParams.get("paymentStatus") || "all").trim();
    const shippingFilter = String(url.searchParams.get("shippingMethod") || "all").trim();
    const page = Math.max(1, Number(url.searchParams.get("page") || "1") || 1);
    const perPage = Math.min(500, Math.max(10, Number(url.searchParams.get("perPage") || "100") || 100));
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

    const localWhere: any = {};
    const localFilters: any[] = [];
    let shippingFilteredIds: number[] | null = null;

    if (query) {
      const normalizedQuery = query.toLowerCase();
      const invoiceId = Number(query.replace(/^inv-/i, ""));

      localFilters.push({
        OR: [
          { customerName: { contains: query, mode: "insensitive" } },
          { shopifyOrderName: { contains: query, mode: "insensitive" } },
          { reference: { contains: query, mode: "insensitive" } },
          { paymentMethod: { contains: query, mode: "insensitive" } },
          { paymentStatus: { contains: query, mode: "insensitive" } },
          ...(Number.isFinite(invoiceId) && invoiceId > 0 ? [{ id: invoiceId }] : []),
          ...(normalizedQuery.includes("paid")
            ? [{ paymentStatus: { contains: normalizedQuery, mode: "insensitive" } }]
            : []),
        ],
      });
    }

    if (paymentFilter !== "all") {
      localFilters.push({ paymentStatus: paymentFilter });
    }

    if (shippingFilter !== "all") {
      try {
        const shippingRows = await prisma.$queryRaw<Array<{ saleId: number }>>`
          SELECT "saleId"
          FROM "SaleShippingMeta"
          WHERE "shippingMethod" = ${shippingFilter === "Delivery" ? "Delivery" : "Collection"}
        `;

        shippingFilteredIds = shippingRows.map((row) => row.saleId);
      } catch (error) {
        console.error("Failed to load shipping filter ids:", error);
        shippingFilteredIds = [];
      }
    }

    if (shippingFilteredIds) {
      localFilters.push({ id: { in: shippingFilteredIds } });
    }

    if (localFilters.length > 0) {
      localWhere.AND = localFilters;
    }

    let xeroConnected = false;
    let unpushedToXeroCount = 0;
    if (xeroConfigured) {
      try {
        const xeroConnection = await getXeroConnection();
        xeroConnected = Boolean(xeroConnection?.tenantId);
      } catch (error) {
        // Keep invoices working even if Xero storage/migrations are unavailable.
        console.error("Failed to load Xero connection status:", error);
        xeroConnected = false;
      }
      if (xeroConnected) {
        try {
          const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`
            SELECT COUNT(*) as count FROM "Sale" s
            WHERE (s."xeroInvoiceId" IS NULL)
              AND (s."shopifyOrderId" IS NULL OR s."shopifyOrderId" NOT LIKE 'xero:%')
              AND EXISTS (
                SELECT 1 FROM "Payment" p
                WHERE p."saleId" = s.id
                  AND (p."xeroInvoiceId" IS NULL
                    OR (p."xeroInvoiceId" = 'PENDING' AND p."createdAt" < NOW() - INTERVAL '10 minutes'))
              )
          `;
          unpushedToXeroCount = Number(rows[0]?.count || 0);
        } catch {
          // Column may not exist yet — ignore
        }
      }
    }

    const [localInvoiceCount, localInvoices] = await Promise.all([
      includeLocal ? prisma.sale.count({ where: localWhere }) : Promise.resolve(0),
      includeLocal
        ? prisma.sale.findMany({
            where: localWhere,
            orderBy: { createdAt: "desc" },
            skip: (page - 1) * perPage,
            take: perPage,
            select: {
              id: true,
              customerName: true,
              customerEmail: true,
              paymentMethod: true,
              paymentStatus: true,
              total: true,
              createdAt: true,
              shopifyOrderName: true,
              reference: true,
              staffId: true,
            },
          })
        : Promise.resolve([]),
    ]);

    const staffIds = Array.from(new Set(localInvoices.map((invoice) => invoice.staffId)));
    const [staffRecords, shippingMetaBySaleId] = await Promise.all([
      staffIds.length
        ? prisma.staff.findMany({
            where: { id: { in: staffIds } },
            select: { id: true, name: true },
          })
        : Promise.resolve([]),
      getSaleShippingMetaBySaleIds(localInvoices.map((invoice) => invoice.id)),
    ]);

    const staffById = new Map(staffRecords.map((staff) => [staff.id, staff.name]));

    const invoices = localInvoices.map((invoice) => ({
      ...invoice,
      staff: staffById.has(invoice.staffId)
        ? { name: staffById.get(invoice.staffId) }
        : null,
      shippingMethod: shippingMetaBySaleId.get(invoice.id)?.shippingMethod || "Collection",
      trackingNumber: shippingMetaBySaleId.get(invoice.id)?.trackingNumber || null,
      trackingUrl: shippingMetaBySaleId.get(invoice.id)?.trackingUrl || null,
      carrierName: shippingMetaBySaleId.get(invoice.id)?.carrierName || null,
      fulfillmentStatus: shippingMetaBySaleId.get(invoice.id)?.fulfillmentStatus || null,
      deliveryStatus: shippingMetaBySaleId.get(invoice.id)?.deliveryStatus || null,
      deliveryMethod: shippingMetaBySaleId.get(invoice.id)?.deliveryMethod || null,
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

    return {
      invoices,
      localInvoiceCount,
      page,
      perPage,
      query,
      paymentFilter,
      shippingFilter,
      customInvoices,
      legacyWorksInvoices,
      shopifyLegacyInvoices,
      source,
      xeroConnected,
      xeroConfigured,
      unpushedToXeroCount,
      error: null,
    };
  } catch (error) {
    if (error instanceof Response) {
      throw error;
    }

    console.error("Failed to load invoices:", error);
    return {
      invoices: [],
      localInvoiceCount: 0,
      page: 1,
      perPage: 100,
      query: "",
      paymentFilter: "all",
      shippingFilter: "all",
      customInvoices: [],
      legacyWorksInvoices: [],
      shopifyLegacyInvoices: [],
      source: "local",
      xeroConnected: false,
      xeroConfigured: false,
      unpushedToXeroCount: 0,
      error: "Invoices could not be loaded right now.",
    };
  }
}

export default function InvoicesPage() {
  const {
    invoices,
    localInvoiceCount,
    page,
    perPage,
    query,
    paymentFilter,
    shippingFilter,
    customInvoices,
    legacyWorksInvoices,
    shopifyLegacyInvoices,
    source,
    xeroConnected,
    xeroConfigured,
    unpushedToXeroCount,
    error,
  } = useLoaderData<typeof loader>();
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const shippingFormRef = useRef<HTMLFormElement | null>(null);
  const [shippingEditorOpen, setShippingEditorOpen] = useState(false);
  const [editingInvoiceId, setEditingInvoiceId] = useState(0);
  const [emailSentModalOpen, setEmailSentModalOpen] = useState(false);
  const [emailSentMessage, setEmailSentMessage] = useState("");
  const [editingShippingMethod, setEditingShippingMethod] = useState("Collection");
  const [editingDeliveryStatus, setEditingDeliveryStatus] = useState("Delivery required");
  const [editingTrackingNumber, setEditingTrackingNumber] = useState("");

  // Local search input state — updates instantly while typing, debounced server fetch
  const [searchInputValue, setSearchInputValue] = useState(query);

  useEffect(() => {
    setSearchInputValue(query);
  }, [query]);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (searchInputValue !== query) {
        updateInvoicesQuery({ query: searchInputValue, page: 1 });
      }
    }, 400);
    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInputValue]);

  const syncStatus = searchParams.get("syncStatus");
  const syncMessage = searchParams.get("syncMessage");

  // Open the email-sent confirmation popup when the action redirects with emailSent status
  useEffect(() => {
    if (syncStatus === "emailSent" && syncMessage) {
      setEmailSentMessage(syncMessage);
      setEmailSentModalOpen(true);
      // Clear the URL params so a refresh doesn't re-open the modal
      const params = new URLSearchParams(location.search);
      params.delete("syncStatus");
      params.delete("syncMessage");
      navigate(withEmbeddedParams(`/app/invoices?${params.toString()}`), { replace: true });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncStatus, syncMessage]);
  const connectXero = searchParams.get("connectXero") === "1";
  const totalPages = Math.max(1, Math.ceil((localInvoiceCount || 0) / perPage));

  function updateInvoicesQuery(updates: Record<string, string | number | null | undefined>) {
    const params = new URLSearchParams(location.search);

    for (const [key, value] of Object.entries(updates)) {
      if (value === null || value === undefined || value === "") {
        params.delete(key);
      } else {
        params.set(key, String(value));
      }
    }

    params.delete("syncStatus");
    params.delete("syncMessage");
    navigate(withEmbeddedParams(`/app/invoices?${params.toString()}`));
  }

  function withEmbeddedParams(path: string) {
    const [pathname, queryString = ""] = path.split("?");
    const currentParams = new URLSearchParams(location.search);
    const nextParams = new URLSearchParams(queryString);
    const storageKey = "shopifyEmbeddedParams";

    let cachedParams: Record<string, string> = {};
    if (typeof window !== "undefined") {
      try {
        cachedParams = JSON.parse(window.sessionStorage.getItem(storageKey) || "{}") || {};
      } catch {
        cachedParams = {};
      }
    }

    let hasLiveParams = false;

    // Preserve Shopify embedded app context so client-side routes don't trigger re-auth.
    for (const key of ["shop", "host", "embedded", "id_token"]) {
      const value = currentParams.get(key);
      if (value) {
        hasLiveParams = true;
        cachedParams[key] = value;
      }

      const resolvedValue = value || cachedParams[key] || "";
      if (resolvedValue && !nextParams.has(key)) {
        nextParams.set(key, resolvedValue);
      }
    }

    if (hasLiveParams && typeof window !== "undefined") {
      try {
        window.sessionStorage.setItem(storageKey, JSON.stringify(cachedParams));
      } catch {
        // Ignore storage write failures and continue with live params.
      }
    }

    const nextQuery = nextParams.toString();
    return nextQuery ? `${pathname}?${nextQuery}` : pathname;
  }

  function openAdminPath(path: string) {
    if (typeof window === "undefined") return;
    if (window.top) {
      window.top.location.href = path;
      return;
    }
    window.location.href = path;
  }

  function openShippingEditor(invoice: any) {
    setEditingInvoiceId(Number(invoice.id || 0));
    setEditingShippingMethod(invoice.shippingMethod === "Delivery" ? "Delivery" : "Collection");
    setEditingDeliveryStatus(
      invoice.shippingMethod === "Delivery"
        ? (invoice.deliveryStatus || "Delivery required")
        : "Shipping not required",
    );
    setEditingTrackingNumber(String(invoice.trackingNumber || ""));
    setShippingEditorOpen(true);
  }

  function getFulfilmentBadge(invoice: any): { label: string; color: string } {
    if (invoice.shippingMethod !== "Delivery") return { label: "Collected", color: "#1f7a1f" };
    const s = String(invoice.deliveryStatus || invoice.fulfillmentStatus || "").toLowerCase();
    if (s === "fulfilled") return { label: "Fulfilled", color: "#1f7a1f" };
    if (s.includes("progress") || s.includes("installation")) return { label: "In Progress", color: "#b26b00" };
    return { label: "Unfulfilled", color: "#b00020" };
  }

  function closeShippingEditor() {
    setShippingEditorOpen(false);
  }

  // Group invoices by calendar date (London time)
  const invoiceGroups = useMemo(() => {
    const tz = "Europe/London";
    const toDateKey = (d: string | Date) =>
      new Intl.DateTimeFormat("en-GB", { dateStyle: "short", timeZone: tz }).format(new Date(d));
    const todayKey = toDateKey(new Date());
    const yesterdayKey = toDateKey(new Date(Date.now() - 86400000));

    const groups: Record<string, { label: string; invoices: any[]; key: string }> = {};
    for (const inv of (invoices as any[])) {
      const key = toDateKey(inv.createdAt);
      if (!groups[key]) {
        let label = key;
        if (key === todayKey) label = "Today";
        else if (key === yesterdayKey) label = "Yesterday";
        groups[key] = { label, invoices: [], key };
      }
      groups[key].invoices.push(inv);
    }
    // Sort newest date first
    return Object.values(groups).sort((a, b) => {
      const [da, ma, ya] = a.key.split("/").map(Number);
      const [db, mb, yb] = b.key.split("/").map(Number);
      return new Date(yb, mb - 1, db).getTime() - new Date(ya, ma - 1, da).getTime();
    });
  }, [invoices]);

  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>(() => ({
    Today: true,
    Yesterday: true,
  }));

  const [expandedInvoices, setExpandedInvoices] = useState<Set<number>>(new Set());

  function toggleGroup(label: string) {
    setExpandedGroups((prev) => ({ ...prev, [label]: !prev[label] }));
  }

  function toggleInvoice(id: number) {
    setExpandedInvoices((prev) => {
      const next = new Set(prev);
      if (next.has(id)) { next.delete(id); } else { next.add(id); }
      return next;
    });
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
                          <Button onClick={() => window.open("/xero/connect", "_blank")}>Connect Xero</Button>
                        ) : null}
                      </>
                    ) : null}

                    <Form method="post">
                      <input type="hidden" name="_intent" value="backfillNcpNumbers" />
                      <Button submit>Recover NCP Numbers</Button>
                    </Form>

                    <Form method="post">
                      <input type="hidden" name="_intent" value="deleteDuplicateInvoices" />
                      <Button submit tone="critical">Delete Duplicates</Button>
                    </Form>

                    <Button
                      variant="primary"
                      onClick={() => navigate(withEmbeddedParams("/app/invoice"))}
                    >
                      Create Invoice
                    </Button>
                  </InlineStack>
                </InlineStack>

                <Form method="get">
                  <BlockStack gap="300">
                    <input type="hidden" name="source" value={source} />
                    <InlineStack gap="300" blockAlign="end">
                      <div style={{ flex: 1, minWidth: 220 }}>
                        <TextField
                          label="Search invoices"
                          name="query"
                          value={searchInputValue}
                          onChange={(value: string) => setSearchInputValue(value)}
                          autoComplete="off"
                          placeholder="Search customer, invoice ref, payment method"
                        />
                      </div>

                      <div style={{ width: 190 }}>
                        <Select
                          label="Payment status"
                          name="paymentStatus"
                          value={paymentFilter}
                          options={[
                            { label: "All payment statuses", value: "all" },
                            { label: "Paid", value: "Paid" },
                            { label: "Partially Paid", value: "Partially Paid" },
                            { label: "Unpaid", value: "Unpaid" },
                          ]}
                          onChange={(value) => updateInvoicesQuery({ paymentStatus: value, page: 1 })}
                        />
                      </div>

                      <div style={{ width: 180 }}>
                        <Select
                          label="Shipping"
                          name="shippingMethod"
                          value={shippingFilter}
                          options={[
                            { label: "All shipping", value: "all" },
                            { label: "Collection", value: "Collection" },
                            { label: "Delivery", value: "Delivery" },
                          ]}
                          onChange={(value) => updateInvoicesQuery({ shippingMethod: value, page: 1 })}
                        />
                      </div>

                      <div style={{ width: 120 }}>
                        <Select
                          label="Per page"
                          name="perPage"
                          value={String(perPage)}
                          options={[
                            { label: "25", value: "25" },
                            { label: "50", value: "50" },
                            { label: "100", value: "100" },
                            { label: "250", value: "250" },
                            { label: "500", value: "500" },
                          ]}
                          onChange={(value) => updateInvoicesQuery({ perPage: value, page: 1 })}
                        />
                      </div>

                      <Button
                        onClick={() => { setSearchInputValue(""); updateInvoicesQuery({ query: "", paymentStatus: "all", shippingMethod: "all", page: 1, perPage: 100 }); }}
                      >
                        Clear filters
                      </Button>
                    </InlineStack>
                  </BlockStack>
                </Form>

                <InlineStack align="space-between" blockAlign="center">
                  <Text as="p" tone="subdued">
                    Showing {(localInvoiceCount ? ((page - 1) * perPage) + 1 : 0)}-
                    {Math.min(page * perPage, localInvoiceCount || 0)} of {localInvoiceCount || 0}
                  </Text>

                  <InlineStack gap="200">
                    <Button
                      disabled={page <= 1}
                      onClick={() => updateInvoicesQuery({ page: page - 1 })}
                    >
                      Previous
                    </Button>

                    <Button
                      disabled={page >= totalPages}
                      onClick={() => updateInvoicesQuery({ page: page + 1 })}
                    >
                      Next
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
                          { label: "Local + scheduled/custom", value: "all" },
                        { label: "Local only", value: "local" },
                          { label: "Scheduled/custom only", value: "custom" },
                      ]}
                      onChange={(value) => navigate(withEmbeddedParams(`/app/invoices?source=${value}`))}
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
              <Banner tone={syncStatus === "success" ? "success" : syncStatus === "warning" ? "warning" : "critical"}>
                {syncMessage}
              </Banner>
            ) : null}

            {xeroConfigured && (!xeroConnected || connectXero) ? (
              <Banner tone="warning">
                Xero is not connected yet. Connect Xero first, then run Sync Xero.
                <div style={{ marginTop: 8 }}>
                  <Button onClick={() => window.open("/xero/connect", "_blank")}>Open Xero connect</Button>
                </div>
              </Banner>
            ) : null}

            {xeroConfigured && xeroConnected && unpushedToXeroCount > 0 ? (
              <Banner tone="warning" title={`${String(unpushedToXeroCount)} paid invoice${unpushedToXeroCount === 1 ? "" : "s"} not yet sent to Xero`}>
                <p>These were likely created from Shopify orders. Click below to push them now.</p>
                <div style={{ marginTop: 8 }}>
                  <Form method="post">
                    <input type="hidden" name="_intent" value="pushUnsentToXero" />
                    <Button submit>{`Push ${unpushedToXeroCount} to Xero`}</Button>
                  </Form>
                </div>
              </Banner>
            ) : null}

            {invoiceGroups.map((group) => {
              const isOpen = expandedGroups[group.label] ?? false;
              return (
                <Card key={group.key} padding="0">
                  <button
                    type="button"
                    onClick={() => toggleGroup(group.label)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      padding: "12px 16px",
                      cursor: "pointer",
                      userSelect: "none",
                      width: "100%",
                      background: "none",
                      border: "none",
                      borderBottom: isOpen ? "1px solid #e1e3e5" : "none",
                      textAlign: "left",
                    }}
                  >
                    <Text as="span" fontWeight="semibold">
                      {group.label} — {group.invoices.length} invoice{group.invoices.length !== 1 ? "s" : ""}
                    </Text>
                    <span style={{ fontSize: 12, color: "#6d7175" }}>{isOpen ? "▲ Collapse" : "▼ Expand"}</span>
                  </button>
                  <Collapsible open={isOpen} id={`group-${group.key}`}>
                  <div style={{ borderTop: isOpen ? "none" : undefined }}>
                {/* Column headers */}
                <div style={{ display: "flex", alignItems: "center", padding: "6px 16px 6px 44px", background: "#f4f6f8", borderBottom: "1px solid #e1e3e5", fontSize: 11, fontWeight: 600, color: "#6d7175", textTransform: "uppercase", letterSpacing: "0.5px", gap: 12 }}>
                  <span style={{ minWidth: 110 }}>Order</span>
                  <span style={{ minWidth: 90 }}>Date</span>
                  <span style={{ flex: 1 }}>Customer</span>
                  <span style={{ minWidth: 90 }}>Fulfilment</span>
                  <span style={{ minWidth: 72, textAlign: "right" }}>Total</span>
                  <span style={{ minWidth: 72, textAlign: "center" }}>Payment</span>
                  <span style={{ minWidth: 90, textAlign: "center" }}>Status</span>
                </div>
                {group.invoices.map((invoice: any) => {
                  const isRowOpen = expandedInvoices.has(Number(invoice.id));
                  const fulfilBadge = getFulfilmentBadge(invoice);
                  return (
                    <div key={invoice.id} style={{ borderBottom: "1px solid #e1e3e5" }}>
                      {/* Compact header row — always visible */}
                      <button
                        type="button"
                        onClick={() => toggleInvoice(Number(invoice.id))}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          width: "100%",
                          padding: "10px 16px",
                          background: "none",
                          border: "none",
                          textAlign: "left",
                          cursor: "pointer",
                          gap: 12,
                        }}
                      >
                        <span style={{ fontSize: 12, color: "#6d7175", minWidth: 10 }}>{isRowOpen ? "▲" : "▼"}</span>
                        {/* Order number */}
                        <span style={{ minWidth: 110 }}>
                          <span style={{ fontWeight: 600, fontSize: 13, display: "block" }}>
                            {invoice.shopifyOrderName || `INV-${invoice.id}`}
                          </span>
                          {invoice.shopifyOrderName ? (
                            <span style={{ fontSize: 11, color: "#6d7175" }}>INV-{invoice.id}</span>
                          ) : null}
                        </span>
                        {/* Date */}
                        <span style={{ fontSize: 12, color: "#6d7175", minWidth: 90 }}>
                          {new Intl.DateTimeFormat("en-GB", { dateStyle: "short", timeZone: "Europe/London" }).format(new Date(invoice.createdAt))}
                        </span>
                        {/* Customer */}
                        <span style={{ flex: 1, fontSize: 13 }}>{invoice.customerName || "-"}</span>
                        {/* Fulfilment type */}
                        <span style={{ fontSize: 12, minWidth: 90, color: "#4b5563" }}>
                          {invoice.shippingMethod === "Delivery" ? "Delivery" : "Collection"}
                        </span>
                        {/* Total */}
                        <span style={{ fontSize: 13, fontWeight: 600, minWidth: 72, textAlign: "right" }}>
                          £{Number(invoice.total ?? 0).toFixed(2)}
                        </span>
                        {/* Payment status */}
                        <span style={{
                          borderRadius: 10,
                          padding: "2px 8px",
                          fontSize: 11,
                          fontWeight: 600,
                          color: "#fff",
                          background: invoice.paymentStatus === "Paid" ? "#1f7a1f" : invoice.paymentStatus === "Partially Paid" ? "#b26b00" : "#b00020",
                          minWidth: 72,
                          textAlign: "center",
                        }}>
                          {invoice.paymentStatus || "Unpaid"}
                        </span>
                        {/* Fulfilment status */}
                        <span style={{
                          borderRadius: 10,
                          padding: "2px 8px",
                          fontSize: 11,
                          fontWeight: 600,
                          color: "#fff",
                          background: fulfilBadge.color,
                          minWidth: 90,
                          textAlign: "center",
                        }}>
                          {fulfilBadge.label}
                        </span>
                      </button>

                      {/* Expanded details */}
                      {isRowOpen && (
                        <div style={{ padding: "0 16px 12px 44px", background: "#f9fafb" }}>
                          <div style={{ display: "flex", gap: 24, marginBottom: 10, flexWrap: "wrap", fontSize: 13 }}>
                            <div>
                              <span style={{ color: "#6d7175", marginRight: 4 }}>Payment:</span>
                              {invoice.paymentMethod || "-"}
                            </div>
                            <div>
                              <span style={{ color: "#6d7175", marginRight: 4 }}>Shipping:</span>
                              {invoice.shippingMethod || "Collection"}
                              {invoice.deliveryMethod ? ` — ${invoice.deliveryMethod}` : ""}
                            </div>
                            {invoice.trackingNumber ? (
                              <div>
                                <span style={{ color: "#6d7175", marginRight: 4 }}>Tracking:</span>
                                {invoice.trackingUrl
                                  ? <a href={invoice.trackingUrl} target="_blank" rel="noreferrer">#{invoice.trackingNumber}</a>
                                  : `#${invoice.trackingNumber}`}
                              </div>
                            ) : null}
                            <div>
                              <span style={{
                                borderRadius: 6,
                                padding: "2px 7px",
                                fontWeight: 600,
                                fontSize: 11,
                                color: "#fff",
                                background: invoice.deliveryStatus === "Fulfilled" ? "#1f7a1f" : invoice.deliveryStatus === "In progress" ? "#b26b00" : invoice.deliveryStatus === "Shipping not required" ? "#5a6268" : "#b00020",
                              }}>
                                {invoice.deliveryStatus || (invoice.shippingMethod === "Collection" ? "Shipping not required" : "Delivery required")}
                              </span>
                            </div>
                          </div>
                          <InlineStack gap="150" wrap={true}>
                            <Button size="slim" onClick={() => navigate(withEmbeddedParams(`/app/invoices/${invoice.id}`))}>View</Button>
                            <Button size="slim" onClick={() => navigate(withEmbeddedParams(`/app/invoice?editInvoiceId=${invoice.id}`))}>Edit</Button>
                            <Button size="slim" onClick={() => openShippingEditor(invoice)}>Shipping</Button>
                            <Form method="post" onSubmit={(e) => { if (!window.confirm(`Email invoice INV-${invoice.id} to ${invoice.customerEmail || "customer"}?`)) e.preventDefault(); }}>
                              <input type="hidden" name="_intent" value="emailInvoice" />
                              <input type="hidden" name="invoiceId" value={invoice.id} />
                              <Button size="slim" submit>Email</Button>
                            </Form>
                            <Form method="post" onSubmit={(e) => { if (!window.confirm(`Delete invoice INV-${invoice.id}? This cannot be undone.`)) e.preventDefault(); }}>
                              <input type="hidden" name="_intent" value="deleteInvoice" />
                              <input type="hidden" name="invoiceId" value={invoice.id} />
                              <Button size="slim" submit tone="critical">Delete</Button>
                            </Form>
                          </InlineStack>
                        </div>
                      )}
                    </div>
                  );
                })}
                  </div>
                  </Collapsible>
                </Card>
              );
            })}

            {customInvoices.length > 0 ? (
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    Custom scheduled invoices
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
                          {formatDateTime(invoice.createdAt)}
                        </IndexTable.Cell>
                        <IndexTable.Cell>
                          <Button onClick={() => navigate(withEmbeddedParams("/app/schedule"))}> 
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
                          {formatDateTime(invoice.createdAt)}
                        </IndexTable.Cell>
                        <IndexTable.Cell>
                          <InlineStack gap="200">
                            <Button onClick={() => navigate(withEmbeddedParams(`/app/works/${invoice.id}`))}>
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
                          {formatDateTime(invoice.createdAt)}
                        </IndexTable.Cell>
                        <IndexTable.Cell>
                          {invoice.adminOrderPath ? (
                            <InlineStack gap="200">
                              <Form method="post">
                                <input type="hidden" name="_intent" value="openShopifyLegacyInEditor" />
                                <input type="hidden" name="openMode" value="view" />
                                <input type="hidden" name="shopifyOrderId" value={invoice.id} />
                                <input type="hidden" name="legacyResourceId" value={invoice.legacyResourceId || ""} />
                                <Button submit>View</Button>
                              </Form>
                              <Form method="post">
                                <input type="hidden" name="_intent" value="openShopifyLegacyInEditor" />
                                <input type="hidden" name="openMode" value="edit" />
                                <input type="hidden" name="shopifyOrderId" value={invoice.id} />
                                <input type="hidden" name="legacyResourceId" value={invoice.legacyResourceId || ""} />
                                <Button submit>Edit Invoice</Button>
                              </Form>
                              <Button onClick={() => openAdminPath(invoice.adminOrderPath)}>
                                Open Order
                              </Button>
                            </InlineStack>
                          ) : (
                            <InlineStack gap="200">
                              <Form method="post">
                                <input type="hidden" name="_intent" value="openShopifyLegacyInEditor" />
                                <input type="hidden" name="openMode" value="view" />
                                <input type="hidden" name="shopifyOrderId" value={invoice.id} />
                                <input type="hidden" name="legacyResourceId" value={invoice.legacyResourceId || ""} />
                                <Button submit>View</Button>
                              </Form>
                              <Form method="post">
                                <input type="hidden" name="_intent" value="openShopifyLegacyInEditor" />
                                <input type="hidden" name="openMode" value="edit" />
                                <input type="hidden" name="shopifyOrderId" value={invoice.id} />
                                <input type="hidden" name="legacyResourceId" value={invoice.legacyResourceId || ""} />
                                <Button submit>Edit Invoice</Button>
                              </Form>
                            </InlineStack>
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

            <Modal
              open={emailSentModalOpen}
              onClose={() => setEmailSentModalOpen(false)}
              title="Email sent"
              primaryAction={{ content: "OK", onAction: () => setEmailSentModalOpen(false) }}
            >
              <Modal.Section>
                <Text as="p">{emailSentMessage}</Text>
              </Modal.Section>
            </Modal>

            <Modal
              open={shippingEditorOpen}
              onClose={closeShippingEditor}
              title={editingInvoiceId ? `Edit Shipping INV-${editingInvoiceId}` : "Edit Shipping"}
              primaryAction={{
                content: "Save shipping",
                onAction: () => shippingFormRef.current?.requestSubmit(),
              }}
              secondaryActions={[{ content: "Cancel", onAction: closeShippingEditor }]}
            >
              <Modal.Section>
                <Form method="post" ref={shippingFormRef}>
                  <input type="hidden" name="_intent" value="updateShippingMeta" />
                  <input type="hidden" name="invoiceId" value={editingInvoiceId} />
                  <input type="hidden" name="shippingMethod" value={editingShippingMethod} />
                  <input
                    type="hidden"
                    name="deliveryStatus"
                    value={editingShippingMethod === "Delivery" ? editingDeliveryStatus : "Shipping not required"}
                  />
                  <input
                    type="hidden"
                    name="trackingNumber"
                    value={editingShippingMethod === "Delivery" ? editingTrackingNumber : ""}
                  />

                  <BlockStack gap="300">
                    <Select
                      label="Shipping / Delivery"
                      options={[
                        { label: "Collection", value: "Collection" },
                        { label: "Delivery", value: "Delivery" },
                      ]}
                      value={editingShippingMethod}
                      onChange={(value) => {
                        setEditingShippingMethod(value === "Delivery" ? "Delivery" : "Collection");
                        if (value !== "Delivery") {
                          setEditingDeliveryStatus("Shipping not required");
                          setEditingTrackingNumber("");
                        } else if (editingDeliveryStatus === "Shipping not required") {
                          setEditingDeliveryStatus("Delivery required");
                        }
                      }}
                    />

                    <Select
                      label="Delivery status"
                      options={[
                        { label: "Shipping not required", value: "Shipping not required" },
                        { label: "Delivery required", value: "Delivery required" },
                        { label: "In progress", value: "In progress" },
                        { label: "Fulfilled", value: "Fulfilled" },
                      ]}
                      value={editingShippingMethod === "Delivery" ? editingDeliveryStatus : "Shipping not required"}
                      onChange={setEditingDeliveryStatus}
                      disabled={editingShippingMethod !== "Delivery"}
                    />

                    <TextField
                      label="Tracking number"
                      value={editingTrackingNumber}
                      onChange={setEditingTrackingNumber}
                      autoComplete="off"
                      placeholder={editingShippingMethod === "Delivery" ? "Enter tracking number" : "Available for delivery orders"}
                      disabled={editingShippingMethod !== "Delivery"}
                    />
                  </BlockStack>
                </Form>
              </Modal.Section>
            </Modal>
          </Layout.Section>
        </Layout>
      </Page>
    </AppProvider>
  );
}