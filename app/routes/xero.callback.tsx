import { getXeroClient, saveXeroConnection } from "../services/xero.server";

function renderHtml(title: string, message: string) {
  return `<html><body style="font-family: sans-serif; text-align: center; padding: 40px;">
    <h1>${title}</h1>
    <p>${message}</p>
  </body></html>`;
}

export async function loader({ request }: { request: Request }) {
  try {
    const xero = getXeroClient();
    const tokenSet = await xero.apiCallback(request.url);
    xero.setTokenSet(tokenSet);
    await xero.updateTenants(false);

    const tenantId = xero.tenants?.[0]?.tenantId;
    if (!tenantId) {
      throw new Error("No Xero organisation was authorised during login.");
    }

    await saveXeroConnection(tenantId, tokenSet);

    return new Response(
      renderHtml("Xero connected successfully", "You can close this tab and return to the app."),
      { headers: { "Content-Type": "text/html" } }
    );
  } catch (error) {
    console.error("Xero OAuth callback failed:", error);
    const message = error instanceof Error ? error.message : "Unknown error";

    return new Response(renderHtml("Failed to connect Xero", message), {
      status: 500,
      headers: { "Content-Type": "text/html" },
    });
  }
}
