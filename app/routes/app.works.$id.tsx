import { Form, Link, useLoaderData, redirect } from "react-router";
import { useState } from "react";
import {
  Page,
  Layout,
  Card,
  Text,
  BlockStack,
  InlineStack,
  Select,
  TextField,
  Button,
  IndexTable,
  Badge,
} from "@shopify/polaris";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { id: string };
}) {
  await authenticate.admin(request);

  const id = Number(params.id);

  const worksOrder = await prisma.worksOrder.findUnique({
    where: { id },
    include: {
      lineItems: true,
    },
  });

  if (!worksOrder) {
    throw new Response("Works order not found", { status: 404 });
  }

  const staff = await prisma.staff.findMany({
    orderBy: { name: "asc" },
  });

return {
  worksOrder: {
    ...worksOrder,
    subtotal: Number(worksOrder.subtotal),
    discountTotal: Number(worksOrder.discountTotal),
    vatAmount: Number(worksOrder.vatAmount),
    total: Number(worksOrder.total),
    amountPaid: Number(worksOrder.amountPaid),
    lineItems: worksOrder.lineItems.map((item) => ({
      ...item,
      unitPrice: Number(item.unitPrice),
      discount: Number(item.discount),
      lineTotal: Number(item.lineTotal),
    })),
  },
  staff,
};
}

export async function action({
  request,
  params,
}: {
  request: Request;
  params: { id: string };
}) {
const { redirect } = await authenticate.admin(request);

  const id = Number(params.id);
  const formData = await request.formData();

  const assignedStaffId = Number(formData.get("assignedStaffId"));
  const scheduledDate = String(formData.get("scheduledDate") || "");

  if (!assignedStaffId) {
    throw new Response("Please choose who this job is assigned to.", {
      status: 400,
    });
  }

  if (!scheduledDate) {
    throw new Response("Please choose a scheduled date.", {
      status: 400,
    });
  }

  await prisma.worksOrder.update({
    where: { id },
    data: {
      assignedStaffId,
      scheduledDate: new Date(scheduledDate),
      status: "scheduled",
    },
  });

  return redirect("/app/works/scheduled");
}

function openPrint(worksOrderId: number) {
  const url = `/app/works/${worksOrderId}/print`;

  if (window.top) {
    window.top.location.href = url;
  } else {
    window.open(url, "_blank");
  }
}

function formatMoney(value: any) {
  return `£${Number(value ?? 0).toFixed(2)}`;
}

function formatDate(value: Date | string | null) {
  if (!value) return "-";
  return new Date(value).toLocaleDateString("en-GB");
}

function paymentBadge(paymentStatus: string) {
  if (paymentStatus === "paid") {
    return <Badge tone="success">Paid</Badge>;
  }

  if (paymentStatus === "part_paid") {
    return <Badge tone="attention">Part paid</Badge>;
  }

  return <Badge tone="critical">Unpaid</Badge>;
}

export default function WorksOrderDetailPage() {
  const { worksOrder, staff } = useLoaderData<typeof loader>();

  const [assignedStaffId, setAssignedStaffId] = useState(
    worksOrder.assignedStaffId ? String(worksOrder.assignedStaffId) : "",
  );

  const [scheduledDate, setScheduledDate] = useState(
    worksOrder.scheduledDate
      ? new Date(worksOrder.scheduledDate).toISOString().slice(0, 10)
      : "",
  );

  const staffOptions = [
    { label: "Choose staff member", value: "" },
    ...staff.map((person: any) => ({
      label: person.name,
      value: String(person.id),
    })),
  ];

  return (
    <Page
      title={`Works Order #${worksOrder.id}`}
      backAction={{
        content:
          worksOrder.status === "scheduled"
            ? "Scheduled Works"
            : "Awaiting Scheduled",
        url:
          worksOrder.status === "scheduled"
            ? "/app/works/scheduled"
            : "/app/works/awaiting-scheduled",
      }}
primaryAction={{
  content: "Print",
  onAction: () => openPrint(worksOrder.id),
}}
    >
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingMd">
                    Customer
                  </Text>

                  <Text as="p" fontWeight="bold">
                    {worksOrder.customerName}
                  </Text>

                  <Text as="p">{worksOrder.customerEmail || "-"}</Text>
                  <Text as="p">{worksOrder.customerPhone || "-"}</Text>
                </BlockStack>

                <BlockStack gap="100">
                  <Text as="h2" variant="headingMd">
                    Status
                  </Text>

                  <Text as="p">
                    Job status:{" "}
                    <Badge
                      tone={
                        worksOrder.status === "scheduled"
                          ? "success"
                          : "attention"
                      }
                    >
                      {worksOrder.status === "scheduled"
                        ? "Scheduled"
                        : "Awaiting scheduled"}
                    </Badge>
                  </Text>

                  <Text as="p">
                    Payment: {paymentBadge(worksOrder.paymentStatus)}
                  </Text>
                </BlockStack>
              </InlineStack>

              <Text as="h2" variant="headingMd">
                Address
              </Text>

              <Text as="p">
                {[
                  worksOrder.address1,
                  worksOrder.address2,
                  worksOrder.city,
                  worksOrder.county,
                  worksOrder.postcode,
                  worksOrder.country,
                ]
                  .filter(Boolean)
                  .join(", ") || "-"}
              </Text>

              <Text as="h2" variant="headingMd">
                Job details
              </Text>

              <Text as="p">Service type: {worksOrder.serviceType}</Text>

              <Text as="p">
                Extra information: {worksOrder.extraInfo || "-"}
              </Text>

              <Text as="p">
                Scheduled date: {formatDate(worksOrder.scheduledDate)}
              </Text>

              <Text as="h2" variant="headingMd">
                Line items
              </Text>

              <IndexTable
                resourceName={{
                  singular: "line item",
                  plural: "line items",
                }}
                itemCount={worksOrder.lineItems.length}
                headings={[
                  { title: "Item" },
                  { title: "SKU" },
                  { title: "Qty" },
                  { title: "Unit price" },
                  { title: "Discount" },
                  { title: "Line total" },
                ]}
                selectable={false}
              >
                {worksOrder.lineItems.map((item: any, index: number) => (
                  <IndexTable.Row
                    id={String(item.id)}
                    key={item.id}
                    position={index}
                  >
                    <IndexTable.Cell>{item.title}</IndexTable.Cell>
                    <IndexTable.Cell>{item.sku || "-"}</IndexTable.Cell>
                    <IndexTable.Cell>{item.quantity}</IndexTable.Cell>
                    <IndexTable.Cell>
                      {formatMoney(item.unitPrice)}
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      {formatMoney(item.discount)}
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      {formatMoney(item.lineTotal)}
                    </IndexTable.Cell>
                  </IndexTable.Row>
                ))}
              </IndexTable>

              <BlockStack gap="100">
                <Text as="p">Subtotal: {formatMoney(worksOrder.subtotal)}</Text>

                <Text as="p">
                  Discount: {formatMoney(worksOrder.discountTotal)}
                </Text>

                <Text as="p">VAT: {formatMoney(worksOrder.vatAmount)}</Text>

                <Text as="p" fontWeight="bold">
                  Total: {formatMoney(worksOrder.total)}
                </Text>

                <Text as="p">
                  Amount paid: {formatMoney(worksOrder.amountPaid)}
                </Text>

                <Text as="p">Payment method: {worksOrder.paymentMethod}</Text>
              </BlockStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section variant="oneThird">
          <Card>
            <Form method="post">
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Schedule Works Order
                </Text>

                <Select
                  label="Assign to staff member"
                  name="assignedStaffId"
                  options={staffOptions}
                  value={assignedStaffId}
                  onChange={setAssignedStaffId}
                />

                <TextField
                  label="Scheduled date"
                  name="scheduledDate"
                  type="date"
                  value={scheduledDate}
                  onChange={setScheduledDate}
                  autoComplete="off"
                />

                <Button submit variant="primary">
                  Save Schedule
                </Button>

         <Button onClick={() => openPrint(worksOrder.id)}>Print Works Order</Button>
              </BlockStack>
            </Form>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}