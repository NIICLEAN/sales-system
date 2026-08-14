import { json } from "react-router";
import type { LoaderFunction } from "react-router";

/**
 * Shopify App Manifest endpoint
 * Required for Shopify Admin to load the app in an iframe
 */
export const loader: LoaderFunction = async () => {
  const appUrl = process.env.SHOPIFY_APP_URL || "";

  return json({
    apiVersion: "2026-07",
    title: "Sales System",
    appUrl: appUrl,
    scopes: process.env.SHOPIFY_API_SCOPES || "",
    webhooks: {
      "orders/paid": {
        deliveryMethod: "http",
        callbackUrl: `${appUrl}/webhooks/orders/paid`,
      },
    },
  });
};

