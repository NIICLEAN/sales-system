import { Form, Link, useLoaderData } from "react-router";
import {
  Page,
  Layout,
  Card,
  Text,
  BlockStack,
  InlineStack,
  Button,
  Badge,
  Select,
} from "@shopify/polaris";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export async function loader({ request }: { request: Request }) {
  await authenticate.admin(request);

  const url = new URL(request.url);
  const startParam = url.searchParams.get("start");
  const staffIdParam = url.searchParams.get("staffId") || "";

  const startDate = startParam ? new Date(startParam) : new Date();
  startDate.setHours(0, 0, 0, 0);

  const endDate = new Date(startDate);
  endDate.setDate(endDate.getDate() + 28);

  const worksOrders = await prisma.worksOrder.findMany({
    where: {
      status: "scheduled",
      scheduledDate: {
        gte: startDate,
        lt: endDate,
      },
      ...(staffIdParam ? { assignedStaffId: Number(staffIdParam) } : {}),
    },
    orderBy: {
      scheduledDate: "asc",
    },
  });

  const staff = await prisma.staff.findMany({
    orderBy: { name: "asc" },
  });

  return {
    startDate: startDate.toISOString(),
    selectedStaffId: staffIdParam,
    worksOrders: worksOrders.map((order) => ({
      ...order,
      total: Number(order.total),
      amountPaid: Number(order.amountPaid),
    })),
    staff,
  };
}

function dateKey(value: Date | string) {
  return new Date(value).toISOString().slice(0, 10);
}

function shortDate(value: Date | string) {
  return new Date(value).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
  });
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

export default function ScheduledWorksPage() {
  const { startDate, worksOrders, staff, selectedStaffId } =
    useLoaderData<typeof loader>();

  const start = new Date(startDate);

  const days = Array.from({ length: 28 }).map((_, index) => {
    const day = new Date(start);
    day.setDate(start.getDate() + index);
    return day;
  });

  const staffOptions = [
    { label: "All staff", value: "" },
    ...staff.map((person: any) => ({
      label: person.name,
      value: String(person.id),
    })),
  ];

  function staffName(staffId: number | null) {
    const person = staff.find((member: any) => member.id === staffId);
    return person?.name || "Unassigned";
  }

  const previousStart = new Date(start);
  previousStart.setDate(previousStart.getDate() - 28);

  const nextStart = new Date(start);
  nextStart.setDate(nextStart.getDate() + 28);

  function calendarUrl(date: Date) {
    const base = `/app/works/scheduled?start=${dateKey(date)}`;

    if (selectedStaffId) {
      return `${base}&staffId=${selectedStaffId}`;
    }

    return base;
  }

  function CalendarWeek({ weekDays }: { weekDays: Date[] }) {
    return (
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(7, minmax(0, 1fr))",
          gap: "12px",
        }}
      >
        {weekDays.map((day) => {
          const jobsForDay = worksOrders.filter(
            (order: any) =>
              order.scheduledDate &&
              dateKey(order.scheduledDate) === dateKey(day),
          );

          return (
            <div
              key={dateKey(day)}
              style={{
                minHeight: "220px",
                border: "1px solid #d9d9d9",
                borderRadius: "12px",
                background: "white",
                padding: "12px",
              }}
            >
              <BlockStack gap="300">
                <Text as="h3" variant="headingSm">
                  {shortDate(day)}
                </Text>

                {jobsForDay.length === 0 && (
                  <Text as="p" tone="subdued">
                    No jobs
                  </Text>
                )}

                {jobsForDay.map((order: any) => (
                  <div
                    key={order.id}
                    style={{
                      border: "1px solid #e1e1e1",
                      borderRadius: "10px",
                      padding: "10px",
                      background: "#f7f7f7",
                    }}
                  >
                    <BlockStack gap="100">
                      <InlineStack align="space-between">
                        <Text as="p" fontWeight="bold">
                          {order.customerName}
                        </Text>

                        {paymentBadge(order.paymentStatus)}
                      </InlineStack>

                      <Text as="p">Service: {order.serviceType}</Text>

                      <Text as="p">
                        Staff: {staffName(order.assignedStaffId)}
                      </Text>

                      <Text as="p">
                        Total: £{Number(order.total || 0).toFixed(2)}
                      </Text>

                      <Link to={`/app/works/${order.id}`}>
                        <Button size="slim">View</Button>
                      </Link>
                    </BlockStack>
                  </div>
                ))}
              </BlockStack>
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <Page
      title="Scheduled Works"
      primaryAction={{
        content: "Create Works Order",
        url: "/app/works/new",
      }}
      secondaryActions={[
        {
          content: "Awaiting Scheduled",
          url: "/app/works/awaiting-scheduled",
        },
        {
          content: "Print Rota",
          url: selectedStaffId
            ? `/app/works/rota/print?start=${dateKey(start)}&staffId=${selectedStaffId}`
            : `/app/works/rota/print?start=${dateKey(start)}`,
        },
      ]}
    >
      <Layout>
        <Layout.Section>
          <InlineStack gap="300" align="space-between">
            <Link to={calendarUrl(previousStart)}>
              <Button>Previous 4 weeks</Button>
            </Link>

            <Text as="p" fontWeight="bold">
              {shortDate(days[0])} to {shortDate(days[27])}
            </Text>

            <Link to={calendarUrl(nextStart)}>
              <Button>Next 4 weeks</Button>
            </Link>
          </InlineStack>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <Form method="get">
              <input type="hidden" name="start" value={dateKey(start)} />

              <InlineStack gap="300" blockAlign="end">
                <div style={{ width: "300px" }}>
                  <Select
                    label="Filter by staff"
                    name="staffId"
                    options={staffOptions}
                    value={selectedStaffId}
                    onChange={() => {}}
                  />
                </div>

                <Button submit>Apply filter</Button>

                <Link to={`/app/works/scheduled?start=${dateKey(start)}`}>
                  <Button>Clear filter</Button>
                </Link>
              </InlineStack>
            </Form>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <BlockStack gap="500">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingLg">
                  Week 1
                </Text>

                <CalendarWeek weekDays={days.slice(0, 7)} />
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingLg">
                  Week 2
                </Text>

                <CalendarWeek weekDays={days.slice(7, 14)} />
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingLg">
                  Week 3
                </Text>

                <CalendarWeek weekDays={days.slice(14, 21)} />
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingLg">
                  Week 4
                </Text>

                <CalendarWeek weekDays={days.slice(21, 28)} />
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}