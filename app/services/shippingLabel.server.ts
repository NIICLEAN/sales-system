type ShippingLabelInput = {
  invoiceId: number;
  shopifyOrderId?: string | null;
  shopifyOrderName?: string | null;
  customerName?: string | null;
  customerEmail?: string | null;
  customerPhone?: string | null;
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  county?: string | null;
  postcode?: string | null;
  country?: string | null;
  deliveryMethod?: string | null;
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

function mapDhlProductCode(deliveryMethod: string) {
  const normalized = String(deliveryMethod || "").trim().toLowerCase();
  if (normalized.includes("pallet international")) return "PINT";
  if (normalized.includes("pallet")) return "PAL";
  if (normalized.includes("long") || normalized.includes("heavy")) return "EXP";
  if (normalized.includes("ireland")) return "NDO";
  return "DOM";
}

function buildDhlAuthHeaders() {
  const apiKey = String(process.env.DHL_API_KEY || "").trim();
  const apiSecret = String(process.env.DHL_API_SECRET || "").trim();
  const username = String(process.env.DHL_USERNAME || "").trim();
  const password = String(process.env.DHL_PASSWORD || "").trim();

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (apiKey && apiSecret) {
    headers.Authorization = `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString("base64")}`;
  } else if (username && password) {
    headers.Authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  }

  return headers;
}

async function generateDhlLabel(input: ShippingLabelInput): Promise<ShippingLabelResult | null> {
  const endpoint = String(process.env.DHL_LABEL_API_URL || "").trim();
  if (!endpoint) return null;

  const accountNumber = String(process.env.DHL_ACCOUNT_NUMBER || "").trim();
  const shipperName = String(process.env.DHL_SHIPPER_NAME || "NII Clean Products").trim();
  const shipperPhone = String(process.env.DHL_SHIPPER_PHONE || "").trim();
  const shipperEmail = String(process.env.DHL_SHIPPER_EMAIL || "").trim();
  const shipperAddress1 = String(process.env.DHL_SHIPPER_ADDRESS1 || "").trim();
  const shipperCity = String(process.env.DHL_SHIPPER_CITY || "").trim();
  const shipperPostalCode = String(process.env.DHL_SHIPPER_POSTCODE || "").trim();
  const shipperCountryCode = String(process.env.DHL_SHIPPER_COUNTRY_CODE || "GB").trim();

  const payload = {
    plannedShippingDateAndTime: new Date().toISOString(),
    productCode: mapDhlProductCode(String(input.deliveryMethod || "")),
    accounts: accountNumber ? [{ typeCode: "shipper", number: accountNumber }] : undefined,
    customerDetails: {
      shipperDetails: {
        postalAddress: {
          postalCode: shipperPostalCode || undefined,
          cityName: shipperCity || undefined,
          countryCode: shipperCountryCode,
          addressLine1: shipperAddress1 || undefined,
        },
        contactInformation: {
          fullName: shipperName,
          phone: shipperPhone || undefined,
          email: shipperEmail || undefined,
        },
      },
      receiverDetails: {
        postalAddress: {
          postalCode: String(input.postcode || "").trim() || undefined,
          cityName: String(input.city || "").trim() || undefined,
          countyName: String(input.county || "").trim() || undefined,
          countryName: String(input.country || "").trim() || undefined,
          countryCode: String(process.env.DHL_DEFAULT_RECEIVER_COUNTRY_CODE || "GB").trim(),
          addressLine1: String(input.address1 || "").trim() || undefined,
          addressLine2: String(input.address2 || "").trim() || undefined,
        },
        contactInformation: {
          fullName: String(input.customerName || "Customer").trim(),
          phone: String(input.customerPhone || "").trim() || undefined,
          email: String(input.customerEmail || "").trim() || undefined,
        },
      },
    },
    content: {
      packages: [
        {
          weight: Number(process.env.DHL_DEFAULT_PACKAGE_WEIGHT_KG || "1"),
          dimensions: {
            length: Number(process.env.DHL_DEFAULT_PACKAGE_LENGTH_CM || "20"),
            width: Number(process.env.DHL_DEFAULT_PACKAGE_WIDTH_CM || "20"),
            height: Number(process.env.DHL_DEFAULT_PACKAGE_HEIGHT_CM || "20"),
          },
        },
      ],
      isCustomsDeclarable: false,
      description: `Invoice INV-${input.invoiceId}`,
    },
    outputImageProperties: {
      printerDPI: 300,
      encodingFormat: "pdf",
      imageOptions: [{ typeCode: "label" }],
    },
    references: [
      {
        value: `INV-${input.invoiceId}`,
        typeCode: "CU",
      },
      {
        value: String(input.shopifyOrderName || input.shopifyOrderId || "").trim() || `INV-${input.invoiceId}`,
        typeCode: "ON",
      },
    ],
  };

  const response = await fetch(endpoint, {
    method: "POST",
    headers: buildDhlAuthHeaders(),
    body: JSON.stringify(payload),
  });

  const json = (await response.json().catch(() => null)) as any;
  if (!response.ok) {
    const message = json?.detail || json?.message || `DHL label API failed with status ${response.status}`;
    throw new Error(String(message));
  }

  const directUrl = String(json?.labelUrl || json?.documents?.[0]?.url || "").trim();
  if (directUrl) {
    return { labelUrl: directUrl };
  }

  const content = String(json?.documents?.[0]?.content || "").trim();
  if (content) {
    return { labelUrl: `data:application/pdf;base64,${content}` };
  }

  return null;
}

export async function generateShippingLabel(
  input: ShippingLabelInput,
): Promise<ShippingLabelResult | null> {
  const provider = String(process.env.SHIPPING_LABEL_PROVIDER || "").trim().toLowerCase();
  if (provider === "dhl") {
    const dhlResult = await generateDhlLabel(input);
    if (dhlResult) return dhlResult;
  }

  const template = String(process.env.SHIPPING_LABEL_URL_TEMPLATE || "").trim();
  const baseUrl = String(process.env.SHIPPING_LABEL_BASE_URL || "").trim();

  const tokens: Record<string, string> = {
    invoiceId: String(input.invoiceId || ""),
    shopifyOrderId: String(input.shopifyOrderId || ""),
    shopifyOrderNumber: extractShopifyNumericOrderId(input.shopifyOrderId),
    shopifyOrderName: String(input.shopifyOrderName || ""),
    customerName: String(input.customerName || ""),
    customerEmail: String(input.customerEmail || ""),
    customerPhone: String(input.customerPhone || ""),
    address1: String(input.address1 || ""),
    address2: String(input.address2 || ""),
    city: String(input.city || ""),
    county: String(input.county || ""),
    postcode: String(input.postcode || ""),
    country: String(input.country || ""),
    deliveryMethod: String(input.deliveryMethod || ""),
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
