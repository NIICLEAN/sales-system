import type { LoaderFunctionArgs } from "react-router";
import { login } from "../../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const shop = process.env.SHOPIFY_SHOP_DOMAIN;

  if (!shop) {
    throw new Response("Missing SHOPIFY_SHOP_DOMAIN", { status: 500 });
  }

  const url = new URL(request.url);
  url.searchParams.set("shop", shop);

  return login(new Request(url.toString(), request));
};

export const action = loader;

export default function AuthLogin() {
  return null;
}