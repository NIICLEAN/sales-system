import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { login } from "../../shopify.server";

function topLevelRedirect(location: string) {
  return new Response(
    `
    <html>
      <body>
        <script>
          window.top.location.href = ${JSON.stringify(location)};
        </script>
      </body>
    </html>
    `,
    {
      headers: {
        "Content-Type": "text/html",
      },
    }
  );
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const shop = process.env.SHOPIFY_SHOP_DOMAIN || "nii-clean-products.myshopify.com";

  const url = new URL(request.url);
  url.searchParams.set("shop", shop);

  const response = await login(new Request(url.toString(), request));

  const location = response.headers.get("Location");

  if (location) {
    return topLevelRedirect(location);
  }

  return response;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  return loader({ request, params: {}, context: {} } as LoaderFunctionArgs);
};

export default function AuthLogin() {
  return null;
}