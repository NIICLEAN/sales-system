type ShippingLabelInput = {
  invoiceId: number;
  shopifyOrderId?: string | null;
  shopifyOrderName?: string | null;
  customerName?: string | null;
  postcode?: string | null;
  country?: string | null;
};

type ShippingLabelResult = {
  labelUrl: string;
};

function extractShopifyNumericOrderId(shopifyOrderId: string | null | undefined) {
  const raw = String(shopifyOrderId || "").trim();
  if (!raw) return "";

  if (raw.startsWith("gid://shopify/Order/")) {
    return raw.replace("gid://shopify/Order/", "").trim();
  }

  return raw;
}

export async function generateShippingLabel(
  input: ShippingLabelInput,
): Promise<ShippingLabelResult | null> {
  const template = String(process.env.SHIPPING_LABEL_URL_TEMPLATE || "").trim();
  const baseUrl = String(process.env.SHIPPING_LABEL_BASE_URL || "").trim();

  const tokens: Record<string, string> = {
    invoiceId: String(input.invoiceId || ""),
    shopifyOrderId: String(input.shopifyOrderId || ""),
    shopifyOrderNumber: extractShopifyNumericOrderId(input.shopifyOrderId),
    shopifyOrderName: String(input.shopifyOrderName || ""),
    customerName: String(input.customerName || ""),
    postcode: String(input.postcode || ""),
    country: String(input.country || ""),
  };

  if (template) {
    const labelUrl = template.replace(/\{(\w+)\}/g, (_, key: string) =>
      encodeURIComponent(tokens[key] || ""),
    );

    if (labelUrl.startsWith("http://") || labelUrl.startsWith("https://")) {
      return { labelUrl };
    }

    return null;
  }

  if (baseUrl) {
    const url = new URL(baseUrl);
    for (const [key, value] of Object.entries(tokens)) {
      if (value) {
        url.searchParams.set(key, value);
      }
    }

    return { labelUrl: url.toString() };
  }

  return null;
}
