import { redirect, Form, useLoaderData } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  Page,
  Layout,
  Card,
  Banner,
  Text,
  BlockStack,
  InlineStack,
  Button,
  Select,
  TextField,
  Modal,
} from "@shopify/polaris";
import { useMemo, useState } from "react";
import db from "../db.server";

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const sales = await db.sale.findMany({
      select: { id: true, shopifyOrderName: true, customerName: true },
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

    return { sales, staff, schedules, error: null };
  } catch (error) {
    console.error("Failed to load schedule:", error);
    return {
      sales: [],
      staff: [],
      schedules: [],
      error: "Schedule could not be loaded right now.",
    };
  }
}

export async function action({ request }: ActionFunctionArgs) {
  const formData = await request.formData();
  const intent = String(formData.get("_intent") || "create");

  if (intent === "delete") {
    await db.workSchedule.delete({
      where: {
        id: Number(formData.get("scheduleId")),
      },
    });

    return redirect("/app/schedule");
  }

  const invoiceMode = String(formData.get("invoiceMode") || "shopify");
  const customInvoiceNumber = String(
    formData.get("customInvoiceNumber") || "",
  ).trim();
  const customCustomerName = String(
    formData.get("customCustomerName") || "",
  ).trim();

  await db.workSchedule.create({
    data: {
      saleId:
        invoiceMode === "shopify" ? Number(formData.get("saleId")) : null,
      customInvoiceNumber:
        invoiceMode === "custom" ? customInvoiceNumber : null,
      customCustomerName:
        invoiceMode === "custom" ? customCustomerName : null,
      workType: String(formData.get("workType")) as any,
      scheduledDate: new Date(String(formData.get("scheduledDate"))),
      assignedStaffId: Number(formData.get("assignedStaffId")) || null,
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

function workTypeLabel(workType: string) {
  if (workType === "CustomBuilds") return "Custom Builds";
  return workType;
}

function workTypeClass(workType: string) {
  if (workType === "Repairs") return "job-repairs";
  if (workType === "Fitting") return "job-fitting";
  if (workType === "CustomBuilds") return "job-custom";
  return "job-default";
}

function invoiceLabel(item: any) {
  if (item.sale) {
    return item.sale.shopifyOrderName || `Invoice #${item.sale.id}`;
  }

  return item.customInvoiceNumber || "Custom invoice";
}

function customerLabel(item: any) {
  if (item.sale) {
    return item.sale.customerName;
  }

  return item.customCustomerName || "No customer name";
}

export default function SchedulePage() {
  const { sales, staff, schedules, error } = useLoaderData<typeof loader>();

  const today = new Date();

  const [modalOpen, setModalOpen] = useState(false);
  const [calendarStartDate, setCalendarStartDate] = useState(
    toDateInputValue(today),
  );
  const [viewStaffId, setViewStaffId] = useState("all");

  const [invoiceMode, setInvoiceMode] = useState("shopify");
  const [saleId, setSaleId] = useState(String(sales[0]?.id || ""));
  const [customInvoiceNumber, setCustomInvoiceNumber] = useState("");
  const [customCustomerName, setCustomCustomerName] = useState("");

  const [workType, setWorkType] = useState("Repairs");
  const [scheduledDate, setScheduledDate] = useState(toDateInputValue(today));
  const [assignedStaffId, setAssignedStaffId] = useState(
    String(staff[0]?.id || ""),
  );
  const [note, setNote] = useState("");

  const saleOptions = sales.map((sale) => ({
    label: `${sale.shopifyOrderName || `Invoice #${sale.id}`} — ${
      sale.customerName
    }`,
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
    return Array.from({ length: 28 }, (_, index) => addDays(start, index));
  }, [calendarStartDate]);

  const visibleSchedules = schedules.filter((item) => {
    if (viewStaffId === "all") return true;
    return String(item.assignedStaffId) === viewStaffId;
  });

  const viewingStaffName =
    viewStaffId === "all"
      ? "All staff"
      : staff.find((person) => String(person.id) === viewStaffId)?.name ||
        "Selected staff";

  return (
    <Page
      fullWidth
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
      <div className="screen-only">
        <Layout>
          <Layout.Section>
            {error ? <Banner tone="critical">{error}</Banner> : null}

            <Card>
              <BlockStack gap="500">
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

                <div className="calendar-heading">
                  <div>
                    <Text as="h2" variant="headingLg">
                      4 Week Works Rota
                    </Text>
                    <Text as="p" tone="subdued">
                      Viewing: {viewingStaffName}
                    </Text>
                  </div>
                </div>

                {[0, 1, 2, 3].map((weekIndex) => (
                  <div key={weekIndex}>
                    <div style={{ marginBottom: 8, marginTop: weekIndex === 0 ? 0 : 16 }}>
                      <Text as="h3" variant="headingMd">Week {weekIndex + 1}</Text>
                    </div>
                    <div className="calendar-grid">
                      {calendarDays.slice(weekIndex * 7, (weekIndex + 1) * 7).map((day) => {
                        const daySchedules = visibleSchedules.filter((item) =>
                          sameDay(new Date(item.scheduledDate), day),
                        );

                        return (
                          <div
                            key={day.toISOString()}
                            className={`calendar-day ${
                              sameDay(day, today) ? "calendar-day-today" : ""
                            }`}
                          >
                            <div className="calendar-date">
                              <span>
                                {day.toLocaleDateString("en-GB", {
                                  weekday: "short",
                                })}
                              </span>
                              <strong>
                                {day.toLocaleDateString("en-GB", {
                                  day: "2-digit",
                                  month: "2-digit",
                                })}
                              </strong>
                            </div>

                            <div className="calendar-jobs">
                              {daySchedules.map((item) => (
                                <div
                                  key={item.id}
                                  className={`job-card ${workTypeClass(
                                    item.workType,
                                  )}`}
                                >
                                  <div className="job-top">
                                    <span className="job-pill">
                                      {workTypeLabel(item.workType)}
                                    </span>

                                    <Form method="post">
                                      <input
                                        type="hidden"
                                        name="_intent"
                                        value="delete"
                                      />
                                      <input
                                        type="hidden"
                                        name="scheduleId"
                                        value={item.id}
                                      />
                                      <button
                                        type="submit"
                                        className="delete-job"
                                        onClick={(event) => {
                                          if (
                                            !confirm(
                                              "Delete this scheduled work item?",
                                            )
                                          ) {
                                            event.preventDefault();
                                          }
                                        }}
                                      >
                                        ×
                                      </button>
                                    </Form>
                                  </div>

                                  <div className="job-invoice">
                                    {invoiceLabel(item)}
                                  </div>

                                  <div className="job-customer">
                                    {customerLabel(item)}
                                  </div>

                                  <div className="job-staff">
                                    {item.assignedStaff?.name || "Unassigned"}
                                  </div>

                                  {item.note ? (
                                    <div className="job-note">{item.note}</div>
                                  ) : null}
                                </div>
                              ))}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>
      </div>

      <div className="print-only">
        <div className="print-header">
          <div>
            <h1 className="print-title">NCP Sales — 4 Week Works Rota</h1>
            <div className="print-subtitle">Staff: {viewingStaffName}</div>
            <div className="print-subtitle">
              From {new Date(calendarStartDate).toLocaleDateString("en-GB")} to{" "}
              {addDays(new Date(calendarStartDate), 27).toLocaleDateString(
                "en-GB",
              )}
            </div>
          </div>

          <div className="print-subtitle">
            Printed: {new Date().toLocaleDateString("en-GB")}
          </div>
        </div>

        <div className="print-grid">
          {calendarDays.map((day) => {
            const daySchedules = visibleSchedules.filter((item) =>
              sameDay(new Date(item.scheduledDate), day),
            );

            return (
              <div className="print-day" key={`print-${day.toISOString()}`}>
                <div className="print-date">
                  {day.toLocaleDateString("en-GB", {
                    weekday: "long",
                    day: "2-digit",
                    month: "2-digit",
                  })}
                </div>

                {daySchedules.map((item) => (
                  <div
                    className={`print-job ${workTypeClass(item.workType)}`}
                    key={`print-job-${item.id}`}
                  >
                    <div className="print-pill">
                      {workTypeLabel(item.workType)}
                    </div>
                    <strong>{invoiceLabel(item)}</strong>
                    <br />
                    {customerLabel(item)}
                    <br />
                    Assigned: {item.assignedStaff?.name || "Unassigned"}
                    {item.note ? (
                      <div className="print-note">{item.note}</div>
                    ) : null}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>

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
              <input type="hidden" name="_intent" value="create" />
              <input type="hidden" name="invoiceMode" value={invoiceMode} />
              <input type="hidden" name="saleId" value={saleId} />
              <input
                type="hidden"
                name="customInvoiceNumber"
                value={customInvoiceNumber}
              />
              <input
                type="hidden"
                name="customCustomerName"
                value={customCustomerName}
              />
              <input type="hidden" name="workType" value={workType} />
              <input type="hidden" name="scheduledDate" value={scheduledDate} />
              <input
                type="hidden"
                name="assignedStaffId"
                value={assignedStaffId}
              />
              <input type="hidden" name="note" value={note} />

              <Select
                label="Invoice source"
                options={[
                  { label: "Shopify invoice", value: "shopify" },
                  { label: "Custom invoice", value: "custom" },
                ]}
                value={invoiceMode}
                onChange={setInvoiceMode}
              />

              {invoiceMode === "shopify" ? (
                <Select
                  label="Invoice"
                  options={saleOptions}
                  value={saleId}
                  onChange={setSaleId}
                />
              ) : (
                <>
                  <TextField
                    label="Custom invoice number"
                    value={customInvoiceNumber}
                    onChange={setCustomInvoiceNumber}
                    autoComplete="off"
                    placeholder="e.g. INV-1042"
                  />

                  <TextField
                    label="Customer name"
                    value={customCustomerName}
                    onChange={setCustomCustomerName}
                    autoComplete="off"
                  />
                </>
              )}

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
          .print-only {
            display: none;
          }

          .calendar-heading {
            display: flex;
            justify-content: space-between;
            align-items: flex-end;
          }

          .calendar-grid {
            display: grid;
            grid-template-columns: repeat(7, minmax(0, 1fr));
            border: 1px solid #dfe3e8;
            border-radius: 14px;
            overflow: hidden;
            background: #fff;
          }

          .calendar-day {
            min-height: 240px;
            min-width: 0;
            border-right: 1px solid #dfe3e8;
            border-bottom: 1px solid #dfe3e8;
            padding: 12px;
            background: #ffffff;
          }

          .calendar-day:nth-child(7n) {
            border-right: 0;
          }

          .calendar-day-today {
            background: #f1f8ff;
          }

          .calendar-date {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 10px;
            color: #202223;
          }

          .calendar-date span {
            font-size: 12px;
            font-weight: 600;
            color: #6d7175;
          }

          .calendar-date strong {
            font-size: 14px;
            font-weight: 800;
          }

          .calendar-jobs {
            display: grid;
            gap: 8px;
          }

          .job-card {
            border-radius: 12px;
            padding: 10px;
            border: 1px solid #dfe3e8;
            box-shadow: 0 1px 2px rgba(0,0,0,0.06);
          }

          .job-repairs {
            background: #fff4e5;
            border-color: #ffc453;
          }

          .job-fitting {
            background: #eaf4ff;
            border-color: #8ac3ff;
          }

          .job-custom {
            background: #f3e8ff;
            border-color: #c084fc;
          }

          .job-default {
            background: #f6f6f7;
          }

          .job-top {
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: 8px;
            margin-bottom: 7px;
          }

          .job-pill {
            display: inline-flex;
            align-items: center;
            border-radius: 999px;
            padding: 3px 8px;
            background: rgba(255,255,255,0.75);
            font-size: 11px;
            font-weight: 800;
            color: #202223;
          }

          .delete-job {
            width: 22px;
            height: 22px;
            border: 0;
            border-radius: 999px;
            background: rgba(0,0,0,0.12);
            cursor: pointer;
            font-size: 16px;
            line-height: 18px;
            font-weight: 700;
          }

          .delete-job:hover {
            background: #d72c0d;
            color: white;
          }

          .job-invoice {
            font-size: 14px;
            font-weight: 800;
            color: #202223;
            margin-bottom: 3px;
          }

          .job-customer {
            font-size: 13px;
            font-weight: 600;
            color: #202223;
          }

          .job-staff {
            display: inline-flex;
            margin-top: 6px;
            border-radius: 999px;
            padding: 3px 8px;
            background: rgba(255,255,255,0.8);
            font-size: 12px;
            font-weight: 700;
            color: #42474c;
          }

          .job-note {
            margin-top: 8px;
            padding-top: 7px;
            border-top: 1px solid rgba(0,0,0,0.12);
            font-size: 12px;
            line-height: 1.4;
            color: #202223;
          }

          @media print {
            @page {
              size: A4 landscape;
              margin: 8mm;
            }

            body {
              background: white !important;
            }

            body * {
              visibility: hidden;
            }

            .print-only,
            .print-only * {
              visibility: visible;
            }

            .print-only {
              display: block !important;
              position: absolute;
              inset: 0;
              padding: 0;
              color: #111;
              font-family: Arial, sans-serif;
            }

            .screen-only,
            .Polaris-Page-Header__RightAlign {
              display: none !important;
            }

            .print-header {
              display: flex;
              justify-content: space-between;
              align-items: flex-start;
              border-bottom: 3px solid #111;
              padding-bottom: 8px;
              margin-bottom: 10px;
            }

            .print-title {
              font-size: 24px;
              font-weight: 800;
              margin: 0;
            }

            .print-subtitle {
              font-size: 13px;
              margin-top: 4px;
            }

            .print-grid {
              display: grid;
              grid-template-columns: repeat(7, 1fr);
              border-top: 1.5px solid #222;
              border-left: 1.5px solid #222;
              width: 100%;
            }

            .print-day {
              min-height: 150px;
              border-right: 1.5px solid #222;
              border-bottom: 1.5px solid #222;
              padding: 7px;
              page-break-inside: avoid;
            }

            .print-date {
              font-size: 13px;
              font-weight: 800;
              border-bottom: 1px solid #bbb;
              padding-bottom: 5px;
              margin-bottom: 6px;
            }

            .print-job {
              font-size: 12px;
              line-height: 1.35;
              margin-bottom: 7px;
              padding: 6px;
              border-radius: 6px;
              border: 1px solid #999;
              page-break-inside: avoid;
            }

            .print-job strong {
              font-size: 12px;
            }

            .print-pill {
              display: inline-block;
              border-radius: 999px;
              padding: 2px 7px;
              font-size: 10px;
              font-weight: 800;
              background: white;
              border: 1px solid #777;
              margin-bottom: 4px;
            }

            .print-note {
              margin-top: 4px;
              padding-top: 4px;
              border-top: 1px dotted #777;
              font-style: italic;
            }

            .print-job.job-repairs {
              background: #fff4e5 !important;
            }

            .print-job.job-fitting {
              background: #eaf4ff !important;
            }

            .print-job.job-custom {
              background: #f3e8ff !important;
            }
          }
        `}
      </style>
    </Page>
  );
}