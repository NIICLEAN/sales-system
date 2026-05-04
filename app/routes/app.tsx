import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Link, Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { NavMenu } from "@shopify/app-bridge-react";
import { AppProvider as ShopifyAppProvider } from "@shopify/shopify-app-react-router/react";
import { AppProvider as PolarisAppProvider } from "@shopify/polaris";
import "@shopify/polaris/build/esm/styles.css";

import { authenticate } from "../shopify.server";

export const loader = async () => {
  return {
    apiKey: process.env.SHOPIFY_API_KEY || "",
  };
};

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();

  return (
    <ShopifyAppProvider apiKey={apiKey}>
      <PolarisAppProvider i18n={{}}>
        <NavMenu>
          <Link to="/app" rel="home">Home</Link>
          <Link to="/app/invoice">Invoice</Link>
          <Link to="/app/invoices">Invoices</Link>
          <Link to="/app/quote">Create Quote</Link>
          <Link to="/app/quotes">Quotes</Link>
          <Link to="/app/reports">Reports</Link>
          <Link to="/app/staff">Staff</Link>
        </NavMenu>

        <Outlet />
      </PolarisAppProvider>
    </ShopifyAppProvider>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};