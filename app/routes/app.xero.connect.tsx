import { useLoaderData } from "react-router";

import { getXeroClient } from "../services/xero.server";

export async function loader() {
  try {
    const xero = getXeroClient();
    const consentUrl = await xero.buildConsentUrl();

    return { consentUrl, error: null };
  } catch (error) {
    console.error("Failed to build Xero consent URL:", error);

    const missing = [
      !process.env.XERO_CLIENT_ID ? "XERO_CLIENT_ID" : null,
      !process.env.XERO_CLIENT_SECRET ? "XERO_CLIENT_SECRET" : null,
      !process.env.XERO_REDIRECT_URI ? "XERO_REDIRECT_URI" : null,
    ].filter(Boolean);

    const detail =
      missing.length > 0
        ? `Missing env: ${missing.join(", ")}`
        : "Xero connection could not be initialized. Check app configuration and redirect URI.";

    return { consentUrl: "", error: detail };
  }
}

export default function XeroConnectPage() {
  const { consentUrl, error } = useLoaderData<typeof loader>();

  return (
    <div style={{ padding: "40px", textAlign: "center" }}>
      <h1>Connect Xero</h1>

      <p>Xero must be opened outside the Shopify frame.</p>

      {error ? (
        <div
          style={{
            margin: "16px auto",
            maxWidth: 760,
            padding: "12px 14px",
            border: "1px solid #d72c0d",
            borderRadius: 8,
            color: "#8a1f11",
            background: "#fff4f4",
            textAlign: "left",
          }}
        >
          {error}
        </div>
      ) : null}

      <a
        href={consentUrl}
        target="_top"
        rel="noopener noreferrer"
        style={{
          display: "inline-block",
          padding: "12px 18px",
          background: "#111",
          color: "white",
          borderRadius: "6px",
          textDecoration: "none",
          fontWeight: "bold",
        }}
        aria-disabled={!consentUrl}
      >
        Open Xero Login
      </a>
    </div>
  );
}