import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Link, Outlet, useLoaderData, useLocation, useNavigate, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { NavMenu } from "@shopify/app-bridge-react";
import { AppProvider as ShopifyAppProvider } from "@shopify/shopify-app-react-router/react";
import { AppProvider as PolarisAppProvider, Button, InlineStack } from "@shopify/polaris";
import "@shopify/polaris/build/esm/styles.css";

import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  return {
    apiKey: process.env.SHOPIFY_API_KEY || "",
  };
};

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();
  const location = useLocation();
  const navigate = useNavigate();

  function withEmbeddedParams(path: string) {
    const [pathname, queryString = ""] = path.split("?");
    const currentParams = new URLSearchParams(location.search);
    const nextParams = new URLSearchParams(queryString);
    const storageKey = "shopifyEmbeddedParams";

    let cachedParams: Record<string, string> = {};
    if (typeof window !== "undefined") {
      try {
        cachedParams = JSON.parse(window.sessionStorage.getItem(storageKey) || "{}") || {};
      } catch {
        cachedParams = {};
      }
    }

    let hasLiveParams = false;

    for (const key of ["shop", "host", "embedded", "id_token"]) {
      const value = currentParams.get(key);
      if (value) {
        hasLiveParams = true;
        cachedParams[key] = value;
      }

      const resolvedValue = value || cachedParams[key] || "";
      if (resolvedValue && !nextParams.has(key)) {
        nextParams.set(key, resolvedValue);
      }
    }

    if (hasLiveParams && typeof window !== "undefined") {
      try {
        window.sessionStorage.setItem(storageKey, JSON.stringify(cachedParams));
      } catch {
        // Ignore storage write failures and continue with live params.
      }
    }

    const nextQuery = nextParams.toString();
    return nextQuery ? `${pathname}?${nextQuery}` : pathname;
  }

  const appNavLinks = [
    { to: "/app", label: "Home" },
    { to: "/app/invoice", label: "Create invoice" },
    { to: "/app/invoices", label: "Invoices" },
    { to: "/app/quote", label: "Create Quote" },
    { to: "/app/quotes", label: "Quotes" },
    { to: "/app/works/awaiting-scheduled", label: "Awaiting Works" },
    { to: "/app/works/scheduled", label: "Scheduled Works" },
    { to: "/app/schedule", label: "Schedule" },
    { to: "/app/reports", label: "Reports" },
    { to: "/app/staff", label: "Staff" },
  ];

  const hideTopNav = /\/print$|\.pdf$/.test(location.pathname);

  return (
    <ShopifyAppProvider embedded apiKey={apiKey}>
      <PolarisAppProvider i18n={{}}>
        <NavMenu>
          <Link to={withEmbeddedParams("/app")} rel="home">
            Home
          </Link>
          <Link to={withEmbeddedParams("/app/invoice")}>Invoice</Link>
          <Link to={withEmbeddedParams("/app/invoices")}>Invoices</Link>
          <Link to={withEmbeddedParams("/app/quote")}>Create Quote</Link>
          <Link to={withEmbeddedParams("/app/quotes")}>Quotes</Link>
          <Link to={withEmbeddedParams("/app/schedule")}>Schedule</Link>
          <Link to={withEmbeddedParams("/app/reports")}>Reports</Link>
          <Link to={withEmbeddedParams("/app/staff")}>Staff</Link>
        </NavMenu>

        {!hideTopNav ? (
          <div style={{ padding: "12px 16px 0 16px", overflowX: "auto" }}>
            <InlineStack gap="200" wrap={false}>
              {appNavLinks.map((item) => (
                <Button
                  key={item.to}
                  onClick={() => navigate(withEmbeddedParams(item.to))}
                  variant={location.pathname === item.to ? "primary" : "secondary"}
                >
                  {item.label}
                </Button>
              ))}
            </InlineStack>
          </div>
        ) : null}

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