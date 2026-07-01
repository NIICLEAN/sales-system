import { redirect, Form, useLoaderData } from "react-router";
import { useState } from "react";
import {
  AppProvider,
  Page,
  Layout,
  Card,
  Banner,
  TextField,
  Button,
  IndexTable,
  Text,
  InlineStack,
} from "@shopify/polaris";
import "@shopify/polaris/build/esm/styles.css";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export async function loader({ request }: { request: Request }) {
  await authenticate.admin(request);

  const url = new URL(request.url);
  const status = String(url.searchParams.get("status") || "");
  const message = String(url.searchParams.get("message") || "");

  const staff = await prisma.staff.findMany({
    orderBy: { createdAt: "desc" },
  });

  return { staff, status, message };
}

export async function action({ request }: { request: Request }) {
  await authenticate.admin(request);

  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");

  if (intent === "create") {
    const name = String(formData.get("name") || "").trim();

    if (name.length > 0) {
      await prisma.staff.create({
        data: { name },
      });
    }
  }

  if (intent === "delete") {
    const staffId = Number(formData.get("staffId"));

    if (staffId) {
      try {
        await prisma.staff.delete({
          where: { id: staffId },
        });
      } catch (error: any) {
        if (error?.code === "P2003") {
          return redirect(
            "/app/staff?status=error&message=Cannot%20delete%20this%20staff%20member%20because%20legacy%20records%20still%20reference%20them",
          );
        }

        return redirect(
          "/app/staff?status=error&message=Failed%20to%20delete%20staff%20member",
        );
      }
    }
  }

  return redirect("/app/staff");
}

export default function StaffPage() {
  const { staff, status, message } = useLoaderData<typeof loader>();
  const [name, setName] = useState("");

  return (
    <AppProvider i18n={{}}>
      <Page title="Staff / Salespeople">
        <Layout>
          <Layout.Section>
            <Card>
              <Form method="post">
                <input type="hidden" name="intent" value="create" />

                <div style={{ display: "flex", gap: "12px", alignItems: "end" }}>
                  <div style={{ flex: 1 }}>
                    <TextField
                      label="Salesperson name"
                      name="name"
                      value={name}
                      onChange={setName}
                      autoComplete="off"
                      placeholder="Example: John"
                    />
                  </div>

                  <Button submit variant="primary">
                    Add Staff
                  </Button>
                </div>
              </Form>
            </Card>
          </Layout.Section>

          <Layout.Section>
            {status && message ? (
              <Banner tone={status === "error" ? "critical" : "success"}>
                {message}
              </Banner>
            ) : null}

          </Layout.Section>

          <Layout.Section>
            <Card>
              <IndexTable
                resourceName={{ singular: "staff member", plural: "staff members" }}
                itemCount={staff.length}
                headings={[
                  { title: "Name" },
                  { title: "Created" },
                  { title: "Actions" },
                ]}
                selectable={false}
              >
                {staff.map((person, index) => (
                  <IndexTable.Row id={String(person.id)} key={person.id} position={index}>
                    <IndexTable.Cell>
                      <Text as="span" fontWeight="bold">
                        {person.name}
                      </Text>
                    </IndexTable.Cell>

                    <IndexTable.Cell>
                      {new Date(person.createdAt).toLocaleString()}
                    </IndexTable.Cell>

                    <IndexTable.Cell>
                      <InlineStack>
                        <Form method="post">
                          <input type="hidden" name="intent" value="delete" />
                          <input type="hidden" name="staffId" value={person.id} />
                          <Button submit tone="critical">
                            Delete
                          </Button>
                        </Form>
                      </InlineStack>
                    </IndexTable.Cell>
                  </IndexTable.Row>
                ))}
              </IndexTable>
            </Card>
          </Layout.Section>
        </Layout>
      </Page>
    </AppProvider>
  );
}