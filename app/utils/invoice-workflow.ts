export const DELIVERY_WORKFLOW_VALUES = [
  "Delivery required",
  "In progress",
  "Installation",
  "Fulfilled",
] as const;

export function shouldCreateShopifyOrder(invoiceTotal: number, lineItemsLength: number, paymentStatus: string) {
  return Number(invoiceTotal || 0) > 0 && Number(lineItemsLength || 0) > 0 && paymentStatus === "Paid";
}

export function shouldAutoFulfillOrder(shippingMethod: string, fulfilmentMethod: string) {
  return shippingMethod === "Collection" || fulfilmentMethod === "Phone";
}

export function normalizeDeliveryWorkflowStatus(shippingMethod: string, inputStatus: string) {
  if (shippingMethod !== "Delivery") {
    return "Shipping not required";
  }

  const candidate = String(inputStatus || "").trim();
  if (DELIVERY_WORKFLOW_VALUES.includes(candidate as (typeof DELIVERY_WORKFLOW_VALUES)[number])) {
    return candidate;
  }

  return "Delivery required";
}

export function calculateInvoiceVat(invoiceNetTotal: number, isVatExempt: boolean, vatRate = 0.2) {
  if (isVatExempt) return 0;
  const rounded = Math.round(Number(invoiceNetTotal || 0) * Number(vatRate || 0) * 100) / 100;
  return rounded;
}
