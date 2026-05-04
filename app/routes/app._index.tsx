import { useNavigate } from "react-router";
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
                <Button variant="primary" onClick={() => navigate("/app/invoice")}>
                  Create Invoice
                </Button>

                <Button onClick={() => navigate("/app/quote")}>
                  Create Quote
                </Button>

                <Button onClick={() => navigate("/app/invoices")}>
                  View Invoices
                </Button>

                <Button onClick={() => navigate("/app/quotes")}>
                  View Quotes
                </Button>

                <Button onClick={() => navigate("/app/reports")}>
                  Reports
                </Button>

                <Button onClick={() => navigate("/app/staff")}>
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