import { redirect, Form, useLoaderData } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  Page,
  Layout,
  Card,
  Text,
  BlockStack,
  InlineStack,
  Button,
  Select,
  TextField,
  DataTable,
  Divider,
} from "@shopify/polaris";
import { useState } from "react";
import db from "../db.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const sales = await db.sale.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  const staff = await db.staff.findMany({
    orderBy: { name: "asc" },
  });

  const schedules = await db.workSchedule.findMany({
    include: {
      sale: true,
      assignedStaff: true,
    },
    orderBy: { scheduledDate: "asc" },
  });

  return { sales, staff, schedules };
}

export async function action({ request }: ActionFunctionArgs) {
  const formData = await request.formData();

  await db.workSchedule.create({
    data: {
      saleId: Number(formData.get("saleId")),
      workType: String(formData.get("workType")) as any,
      scheduledDate: new Date(String(formData.get("scheduledDate"))),
      assignedStaffId: Number(formData.get("assignedStaffId")),
      note: String(formData.get("note") || ""),
    },
  });

  return redirect("/app/schedule");
}

export default function SchedulePage() {
  const { sales, staff, schedules } = useLoaderData<typeof loader>();

  const [saleId, setSaleId] = useState(String(sales[0]?.id || ""));
  const [workType, setWorkType] = useState("Repairs");
  const [scheduledDate, setScheduledDate] = useState("");
  const [assignedStaffId, setAssignedStaffId] = useState(String(staff[0]?.id || ""));
  const [note, setNote] = useState("");

  const saleOptions = sales.map((sale) => ({
    label: `${sale.shopifyOrderName || `Invoice #${sale.id}`} — ${sale.customerName}`,
    value: String(sale.id),
  }));

  const staffOptions = staff.map((person) => ({
    label: person.name,
    value: String(person.id),
  }));

  const rows = schedules.map((item) => [
    new Date(item.scheduledDate).toLocaleDateString("en-GB"),
    item.sale.shopifyOrderName || `#${item.sale.id}`,
    item.sale.customerName,
    item.workType === "CustomBuilds" ? "Custom Builds" : item.workType,
    item.assignedStaff.name,
    item.note || "",
  ]);

  return (
    <Page
      title="Works Schedule"
      primaryAction={{
        content: "Print Rota",
        onAction: () => window.print(),
      }}
    >
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                Schedule Works
              </Text>

              <Form method="post">
                <BlockStack gap="400">
                  <input type="hidden" name="saleId" value={saleId} />
                  <input type="hidden" name="workType" value={workType} />
                  <input type="hidden" name="scheduledDate" value={scheduledDate} />
                  <input type="hidden" name="assignedStaffId" value={assignedStaffId} />
                  <input type="hidden" name="note" value={note} />

                  <Select
                    label="Invoice"
                    options={saleOptions}
                    value={saleId}
                    onChange={setSaleId}
                  />

                  <InlineStack gap="400" wrap>
                    <div style={{ minWidth: 220, flex: 1 }}>
                      <Select
                        label="Work type"
                        options={[
                          { label: "Repairs", value: "Repairs" },
                          { label: "Fitting", value: "Fitting" },
                          { label: "Custom Builds", value: "CustomBuilds" },
                        ]}
                        value={workType}
                        onChange={setWorkType}
                      />
                    </div>

                    <div style={{ minWidth: 220, flex: 1 }}>
                      <TextField
                        label="Date"
                        type="date"
                        value={scheduledDate}
                        onChange={setScheduledDate}
                        autoComplete="off"
                      />
                    </div>

                    <div style={{ minWidth: 220, flex: 1 }}>
                      <Select
                        label="Assigned to"
                        options={staffOptions}
                        value={assignedStaffId}
                        onChange={setAssignedStaffId}
                      />
                    </div>
                  </InlineStack>

                  <TextField
                    label="Note"
                    value={note}
                    onChange={setNote}
                    multiline={4}
                    autoComplete="off"
                  />

                  <InlineStack align="end">
                    <Button variant="primary" submit>
                      Schedule Works
                    </Button>
                  </InlineStack>
                </BlockStack>
              </Form>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                Calendar
              </Text>

              <Divider />

              {rows.length ? (
                <DataTable
                  columnContentTypes={["text", "text", "text", "text", "text", "text"]}
                  headings={["Date", "Invoice", "Customer", "Type", "Assigned To", "Note"]}
                  rows={rows}
                />
              ) : (
                <Text as="p" tone="subdued">
                  No works scheduled yet.
                </Text>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}