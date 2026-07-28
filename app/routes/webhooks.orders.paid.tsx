import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { pushNewPaymentsToXero } from "../services/xero.server";
import { createSaleCompat } from "../services/saleCompat.server";

/**
 * Maps a Shopify payment gateway name to our internal PaymentMethod enum value.
 */
function mapGatewayToPaymentMethod(gateway: string | null | undefined): string {
  const g = (gateway || "").toLowerCase();
  if (g.includes("mypos")) return "MyPos";
  if (g.includes("worldpay")) return "Worldpay";
  if (g.includes("bank") || g.includes("transfer")) return "BankTransfer";
  if (g === "manual" || g.includes("cash") || g.includes("cod")) return "Cash";
  if (
    g.includes("shopify_payments") ||
    g.includes("stripe") ||
    g.includes("card") ||
    g.includes("credit") ||
    g.includes("paypal")
  )
    return "Card";
  return "Other";
}

/**
 * Handles Shopify orders/paid webhook.
 *
 * When a customer places and pays for an order directly on Shopify (not via
 * our manual invoice flow), this webhook fires.  We create a Sale + Payment
 * record in our system and auto-push a Xero invoice — exactly the same path
 * as a manually created invoice with a payment recorded.
 *
 * Idempotency: if a Sale already exists for this shopifyOrderId (because staff
 * also created a manual invoice and linked it to this Shopify order), we skip
 * creation entirely so nothing is double-counted.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, payload } = await authenticate.webhook(request);

  console.log(`[webhook] Received ${topic}`);

  const order = payload as any;

  const shopifyOrderId = String(
    order.admin_graphql_api_id || `gid://shopify/Order/${order.id}`,
  );
  const shopifyOrderName = String(order.name || "").trim();

  // ------------------------------------------------------------------
  // Idempotency — skip if a Sale already exists for this Shopify order.
  // This covers the case where staff created a manual invoice in our app
  // and used "Create Shopify Order", which sets shopifyOrderId on the Sale.
  // ------------------------------------------------------------------
  const existing = await prisma.sale.findFirst({
    where: {
      OR: [
        { shopifyOrderId },
        // Also match by order name in case the GID format differs between
        // app versions (e.g. numeric ID vs full GID string).
        ...(shopifyOrderName
          ? [{ shopifyOrderName, shopifyOrderId: { not: null } }]
          : []),
      ],
    },
    select: { id: true },
  });

  if (existing) {
    console.log(
      `[orders/paid] Sale already exists for ${shopifyOrderName} (id=${existing.id}) — skipping`,
    );
    return new Response("ok");
  }

  // ------------------------------------------------------------------
  // Default staff — required for Sale creation.
  // ------------------------------------------------------------------
  const defaultStaff = await prisma.staff.findFirst({ orderBy: { id: "asc" } });
  if (!defaultStaff) {
    console.error("[orders/paid] No staff record found — cannot create sale");
    return new Response("ok");
  }

  // ------------------------------------------------------------------
  // Money values (Shopify sends strings).
  // ------------------------------------------------------------------
  const total = Math.round(parseFloat(order.total_price || "0") * 100) / 100;
  const subtotal = Math.round(parseFloat(order.subtotal_price || "0") * 100) / 100;
  const vatAmount = Math.round(parseFloat(order.total_tax || "0") * 100) / 100;
  const discountTotal = Math.round(parseFloat(order.total_discounts || "0") * 100) / 100;

  // ------------------------------------------------------------------
  // VAT type — CrossBorder for non-GB billing addresses.
  // ------------------------------------------------------------------
  const countryCode =
    order.billing_address?.country_code ||
    order.shipping_address?.country_code ||
    "GB";
  const vatType = countryCode === "GB" ? "Standard" : "CrossBorder";

  // ------------------------------------------------------------------
  // Payment method.
  // ------------------------------------------------------------------
  const gateway: string | null =
    order.gateway || order.payment_gateway_names?.[0] || null;
  const paymentMethod = mapGatewayToPaymentMethod(gateway);

  // ------------------------------------------------------------------
  // Customer details.
  // ------------------------------------------------------------------
  const billingAddress = order.billing_address || order.shipping_address || {};
  const customerName =
    [billingAddress.first_name, billingAddress.last_name]
      .filter(Boolean)
      .join(" ") ||
    [order.customer?.first_name, order.customer?.last_name]
      .filter(Boolean)
      .join(" ") ||
    "Shopify Customer";

  // ------------------------------------------------------------------
  // Line items — store titles/quantities for Xero invoice description.
  // Prices are stored as Shopify reports them (VAT-inclusive for UK stores).
  // ------------------------------------------------------------------
  const lineItems = (order.line_items || []).map((li: any) => {
    const unitPrice = Math.round(parseFloat(li.price || "0") * 100) / 100;
    const qty = Number(li.quantity) || 1;
    const itemDiscount = Math.round(parseFloat(li.total_discount || "0") * 100) / 100;
    const lineTotal = Math.round((unitPrice * qty - itemDiscount) * 100) / 100;
    const variantTitle =
      li.variant_title && li.variant_title !== "Default Title"
        ? ` - ${li.variant_title}`
        : "";

    return {
      shopifyVariantId: li.variant_id
        ? `gid://shopify/ProductVariant/${li.variant_id}`
        : null,
      title: `${li.title}${variantTitle}`,
      sku: li.sku || null,
      quantity: qty,
      unitPrice,
      discount: Math.round((itemDiscount / qty) * 100) / 100,
      lineTotal,
      isCustom: false,
    };
  });

  // ------------------------------------------------------------------
  // Create Sale + Payment + push to Xero.
  // ------------------------------------------------------------------
  try {
    const sale = await createSaleCompat({
      sale: {
        shopifyOrderId,
        shopifyOrderName,
        customerId: order.customer?.id ? String(order.customer.id) : null,
        customerName,
        customerEmail: order.email || order.customer?.email || null,
        customerPhone:
          order.phone || billingAddress.phone || order.customer?.phone || null,
        address1: billingAddress.address1 || null,
        address2: billingAddress.address2 || null,
        city: billingAddress.city || null,
        county: billingAddress.province || null,
        postcode: billingAddress.zip || null,
        country: billingAddress.country || null,
        reference: shopifyOrderName,
        paymentMethod,
        subtotal,
        discountTotal,
        vatAmount,
        total,
        amountPaid: total,
        balanceDue: 0,
        paymentStatus: "Paid",
        depositPaid: true,
        vatType,
        staffId: defaultStaff.id,
        createdAt: order.created_at ? new Date(order.created_at) : undefined,
      },
      lineItems,
    });

    await prisma.payment.create({
      data: {
        saleId: sale.id,
        amount: total,
        method: paymentMethod as any,
        provider: gateway || null,
        reference: shopifyOrderName,
      },
    });

    console.log(
      `[orders/paid] Created sale ${sale.id} for Shopify order ${shopifyOrderName} (£${total})`,
    );

    // Auto-push to Xero — fire-and-forget, errors logged not thrown.
    pushNewPaymentsToXero(sale.id).catch((err) =>
      console.error(
        `[orders/paid] Xero push failed for sale ${sale.id}:`,
        err?.message || err,
      ),
    );
  } catch (err: any) {
    console.error(
      `[orders/paid] Failed to process order ${shopifyOrderName}:`,
      err?.message || err,
    );
  }

  return new Response("ok");
};
