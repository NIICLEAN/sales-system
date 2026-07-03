import { describe, expect, it } from "vitest";

import {
  calculateInvoiceVat,
  normalizeDeliveryWorkflowStatus,
  shouldAutoFulfillOrder,
  shouldCreateShopifyOrder,
} from "./invoice-workflow";

describe("invoice workflow guards", () => {
  it("creates a Shopify order for valid invoice totals even when unpaid", () => {
    expect(shouldCreateShopifyOrder(100, 1)).toBe(true);
    expect(shouldCreateShopifyOrder(100, 0)).toBe(false);
    expect(shouldCreateShopifyOrder(0, 1)).toBe(false);
  });

  it("auto-fulfills collection and phone orders", () => {
    expect(shouldAutoFulfillOrder("Collection", "Collected")).toBe(true);
    expect(shouldAutoFulfillOrder("Delivery", "Phone")).toBe(true);
    expect(shouldAutoFulfillOrder("Delivery", "Delivery")).toBe(false);
  });

  it("normalizes delivery workflow status", () => {
    expect(normalizeDeliveryWorkflowStatus("Delivery", "In progress")).toBe("In progress");
    expect(normalizeDeliveryWorkflowStatus("Delivery", "unknown value")).toBe("Delivery required");
    expect(normalizeDeliveryWorkflowStatus("Collection", "Fulfilled")).toBe("Shipping not required");
  });

  it("calculates VAT from invoice net total", () => {
    expect(calculateInvoiceVat(100, false, 0.2)).toBe(20);
    expect(calculateInvoiceVat(99.99, false, 0.2)).toBe(20);
    expect(calculateInvoiceVat(100, true, 0.2)).toBe(0);
  });
});
