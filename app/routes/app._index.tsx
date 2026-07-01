import { useLocation, useNavigate } from "react-router";
import {
  Page,
  Layout,
  Card,
  Button,
  BlockStack,
  InlineStack,
  Text,
} from "@shopify/polaris";

export default function AppHome() {
  const navigate = useNavigate();
  const location = useLocation();

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

  return (
    <Page title="NCP Sales">
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingLg">
                What would you like to do?
              </Text>

              <InlineStack gap="300">
                <Button variant="primary" onClick={() => navigate(withEmbeddedParams("/app/invoice"))}>
                  Create Invoice
                </Button>

                <Button onClick={() => navigate(withEmbeddedParams("/app/quote"))}>
                  Create Quote
                </Button>

                <Button onClick={() => navigate(withEmbeddedParams("/app/invoices"))}>
                  View Invoices
                </Button>

                <Button onClick={() => navigate(withEmbeddedParams("/app/quotes"))}>
                  View Quotes
                </Button>

                <Button onClick={() => navigate(withEmbeddedParams("/app/reports"))}>
                  Reports
                </Button>

                <Button onClick={() => navigate(withEmbeddedParams("/app/staff"))}>
                  Staff
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}