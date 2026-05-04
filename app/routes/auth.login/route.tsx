import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { login } from "../../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const shop =
    process.env.SHOPIFY_SHOP_DOMAIN || "niicleanproducts.myshopify.com";

  const url = new URL(request.url);
  url.searchParams.set("shop", shop);

  return login(new Request(url.toString(), request));
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const shop =
    process.env.SHOPIFY_SHOP_DOMAIN || "niicleanproducts.myshopify.com";

  const url = new URL(request.url);
  url.searchParams.set("shop", shop);

  return login(new Request(url.toString(), request));
};

export default function AuthLogin() {
  return null;
}