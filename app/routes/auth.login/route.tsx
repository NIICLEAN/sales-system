import { useEffect } from "react";
import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const shop =
    process.env.SHOPIFY_SHOP_DOMAIN || "nii-clean-products.myshopify.com";

  const location = `/auth?shop=${shop}`;

  return { location };
};

export const action = loader;

export default function AuthLogin() {
  const { location } = useLoaderData<typeof loader>();

  useEffect(() => {
    window.open(location, "_top");
  }, [location]);

  return (
    <div style={{ padding: 40 }}>
      <h2>Redirecting to Shopify login...</h2>
      <a href={location} target="_top">
        Click here if it does not continue
      </a>
    </div>
  );
}