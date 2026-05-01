import { redirect, Form, useLoaderData } from "react-router";
import { useState } from "react";
import {
  AppProvider,
  Page,
  Layout,
  Card,
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

  const staff = await prisma.staff.findMany({
    orderBy: { createdAt: "desc" },
  });

  return { staff };
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
      await prisma.staff.delete({
        where: { id: staffId },
      });
    }
  }

  return redirect("/app/staff");
}

export default function StaffPage() {
  const { staff } = useLoaderData<typeof loader>();
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