import { useLoaderData } from "react-router";

import { authenticate } from "../shopify.server";
import { getXeroClient } from "../services/xero.server";

export async function loader({ request }: { request: Request }) {
  await authenticate.admin(request);

  const xero = getXeroClient();
  const consentUrl = await xero.buildConsentUrl();

  return { consentUrl };
}

export default function XeroConnectPage() {
  const { consentUrl } = useLoaderData<typeof loader>();

  return (
    <div style={{ padding: "40px", textAlign: "center" }}>
      <h1>Connect Xero</h1>

      <p>Xero must be opened outside the Shopify frame.</p>

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
      >
        Open Xero Login
      </a>
    </div>
  );
}