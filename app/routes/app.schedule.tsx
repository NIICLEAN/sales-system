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
  Modal,
  Box,
  Badge,
} from "@shopify/polaris";
import { useMemo, useState } from "react";
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

function toDateInputValue(date: Date) {
  return date.toISOString().split("T")[0];
}

function addDays(date: Date, days: number) {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
}

function sameDay(a: Date, b: Date) {
  return a.toDateString() === b.toDateString();
}

export default function SchedulePage() {
  const { sales, staff, schedules } = useLoaderData<typeof loader>();

  const today = new Date();

  const [modalOpen, setModalOpen] = useState(false);

  const [calendarStartDate, setCalendarStartDate] = useState(
    toDateInputValue(today),
  );

  const [viewStaffId, setViewStaffId] = useState("all");

  const [saleId, setSaleId] = useState(String(sales[0]?.id || ""));
  const [workType, setWorkType] = useState("Repairs");
  const [scheduledDate, setScheduledDate] = useState(toDateInputValue(today));
  const [assignedStaffId, setAssignedStaffId] = useState(
    String(staff[0]?.id || ""),
  );
  const [note, setNote] = useState("");

  const saleOptions = sales.map((sale) => ({
    label: `${sale.shopifyOrderName || `Invoice #${sale.id}`} — ${sale.customerName}`,
    value: String(sale.id),
  }));

  const staffOptions = staff.map((person) => ({
    label: person.name,
    value: String(person.id),
  }));

  const viewStaffOptions = [
    { label: "All staff", value: "all" },
    ...staffOptions,
  ];

  const calendarDays = useMemo(() => {
    const start = new Date(calendarStartDate);
    return Array.from({ length: 14 }, (_, index) => addDays(start, index));
  }, [calendarStartDate]);

  const visibleSchedules = schedules.filter((item) => {
    if (viewStaffId === "all") return true;
    return String(item.assignedStaffId) === viewStaffId;
  });

  return (
    <Page
      title="Works Calendar"
      primaryAction={{
        content: "Schedule Works",
        onAction: () => setModalOpen(true),
      }}
      secondaryActions={[
        {
          content: "Print Calendar",
          onAction: () => window.print(),
        },
      ]}
    >
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack gap="400" align="space-between" blockAlign="end">
                <div style={{ minWidth: 260 }}>
                  <Select
                    label="View staff calendar"
                    options={viewStaffOptions}
                    value={viewStaffId}
                    onChange={setViewStaffId}
                  />
                </div>

                <div style={{ minWidth: 220 }}>
                  <TextField
                    label="Calendar start date"
                    type="date"
                    value={calendarStartDate}
                    onChange={setCalendarStartDate}
                    autoComplete="off"
                  />
                </div>
              </InlineStack>

              <div className="print-title">
                <Text as="h2" variant="headingLg">
                  2 Week Works Rota
                </Text>
              </div>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(7, minmax(120px, 1fr))",
                  border: "1px solid #ddd",
                  borderRadius: 12,
                  overflow: "hidden",
                }}
              >
                {calendarDays.map((day) => {
                  const daySchedules = visibleSchedules.filter((item) =>
                    sameDay(new Date(item.scheduledDate), day),
                  );

                  return (
                    <div
                      key={day.toISOString()}
                      style={{
                        minHeight: 170,
                        borderRight: "1px solid #ddd",
                        borderBottom: "1px solid #ddd",
                        padding: 10,
                        background: sameDay(day, today) ? "#f4f6f8" : "white",
                      }}
                    >
                      <BlockStack gap="200">
                        <Text as="p" variant="headingSm">
                          {day.toLocaleDateString("en-GB", {
                            weekday: "short",
                            day: "2-digit",
                            month: "2-digit",
                          })}
                        </Text>

                        {daySchedules.map((item) => (
                          <Box
                            key={item.id}
                            padding="200"
                            background="bg-surface-secondary"
                            borderRadius="200"
                          >
                            <BlockStack gap="100">
                              <InlineStack gap="100">
                                <Badge>
                                  {item.workType === "CustomBuilds"
                                    ? "Custom"
                                    : item.workType}
                                </Badge>
                              </InlineStack>

                              <Text as="p" variant="bodySm" fontWeight="bold">
                                {item.sale.shopifyOrderName ||
                                  `Invoice #${item.sale.id}`}
                              </Text>

                              <Text as="p" variant="bodySm">
                                {item.sale.customerName}
                              </Text>

                              <Text as="p" variant="bodySm" tone="subdued">
                                {item.assignedStaff.name}
                              </Text>

                              {item.note ? (
                                <Text as="p" variant="bodySm">
                                  {item.note}
                                </Text>
                              ) : null}
                            </BlockStack>
                          </Box>
                        ))}
                      </BlockStack>
                    </div>
                  );
                })}
              </div>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title="Schedule Works"
        primaryAction={{
          content: "Close",
          onAction: () => setModalOpen(false),
        }}
      >
        <Modal.Section>
          <Form method="post">
            <BlockStack gap="400">
              <input type="hidden" name="saleId" value={saleId} />
              <input type="hidden" name="workType" value={workType} />
              <input type="hidden" name="scheduledDate" value={scheduledDate} />
              <input
                type="hidden"
                name="assignedStaffId"
                value={assignedStaffId}
              />
              <input type="hidden" name="note" value={note} />

              <Select
                label="Invoice"
                options={saleOptions}
                value={saleId}
                onChange={setSaleId}
              />

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

              <TextField
                label="Date"
                type="date"
                value={scheduledDate}
                onChange={setScheduledDate}
                autoComplete="off"
              />

              <Select
                label="Assigned to"
                options={staffOptions}
                value={assignedStaffId}
                onChange={setAssignedStaffId}
              />

              <TextField
                label="Note"
                value={note}
                onChange={setNote}
                multiline={4}
                autoComplete="off"
              />

              <InlineStack align="end">
                <Button variant="primary" submit>
                  Save Schedule
                </Button>
              </InlineStack>
            </BlockStack>
          </Form>
        </Modal.Section>
      </Modal>

      <style>
        {`
          @media print {
            body * {
              visibility: hidden;
            }

            .Polaris-Page,
            .Polaris-Page * {
              visibility: visible;
            }

            button,
            select,
            input,
            .Polaris-Modal-Dialog__Container,
            .Polaris-Page-Header__RightAlign {
              display: none !important;
            }

            .Polaris-Page {
              position: absolute;
              left: 0;
              top: 0;
              width: 100%;
            }
          }
        `}
      </style>
    </Page>
  );
}