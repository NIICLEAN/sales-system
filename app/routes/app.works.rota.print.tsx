import { useEffect } from "react";
import { useLoaderData } from "react-router";

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
  endDate.setDate(endDate.getDate() + 14);

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
    orderBy: {
      name: "asc",
    },
  });

  const selectedStaff = staffIdParam
    ? await prisma.staff.findUnique({
        where: {
          id: Number(staffIdParam),
        },
      })
    : null;

  return {
    startDate: startDate.toISOString(),
    worksOrders: worksOrders.map((order) => ({
      ...order,
      total: Number(order.total),
      amountPaid: Number(order.amountPaid),
    })),
    staff,
    selectedStaff,
  };
}

function dateKey(value: Date | string) {
  return new Date(value).toISOString().slice(0, 10);
}

function formatDate(value: Date | string) {
  return new Date(value).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

export default function PrintRotaPage() {
  const { startDate, worksOrders, staff, selectedStaff } =
    useLoaderData<typeof loader>();

  const start = new Date(startDate);

  const days = Array.from({ length: 14 }).map((_, index) => {
    const day = new Date(start);
    day.setDate(start.getDate() + index);
    return day;
  });

  function staffName(staffId: number | null) {
    const person = staff.find((member: any) => member.id === staffId);
    return person?.name || "Unassigned";
  }

  useEffect(() => {
    const timer = window.setTimeout(() => {
      window.print();
    }, 500);

    return () => window.clearTimeout(timer);
  }, []);

  function CalendarWeek({ weekDays }: { weekDays: Date[] }) {
    return (
      <div className="calendar-grid">
        {weekDays.map((day) => {
          const jobsForDay = worksOrders.filter(
            (order: any) =>
              order.scheduledDate &&
              dateKey(order.scheduledDate) === dateKey(day),
          );

          return (
            <div className="day-box" key={dateKey(day)}>
              <h3>{formatDate(day)}</h3>

              {jobsForDay.length === 0 && <p className="muted">No jobs</p>}

              {jobsForDay.map((order: any) => (
                <div className="job-card" key={order.id}>
                  <strong>{order.customerName}</strong>
                  <p>Service: {order.serviceType}</p>
                  <p>Staff: {staffName(order.assignedStaffId)}</p>
                  <p>
                    Address:{" "}
                    {[
                      order.address1,
                      order.address2,
                      order.city,
                      order.county,
                      order.postcode,
                      order.country,
                    ]
                      .filter(Boolean)
                      .join(", ") || "-"}
                  </p>
                  <p>Notes: {order.extraInfo || "-"}</p>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div className="page">
      <style>{`
        body {
          margin: 0;
          background: #f4f4f4;
          font-family: Arial, sans-serif;
          color: #111;
        }

        .page {
          max-width: 1200px;
          margin: 30px auto;
          background: white;
          padding: 35px;
          box-shadow: 0 0 10px rgba(0,0,0,0.12);
        }

        .actions {
          margin-bottom: 24px;
        }

        button {
          padding: 9px 15px;
          margin-right: 8px;
          cursor: pointer;
          border: 1px solid #111;
          background: #111;
          color: white;
          border-radius: 6px;
          font-weight: 600;
        }

        button.secondary {
          background: white;
          color: #111;
        }

        .header {
          display: flex;
          justify-content: space-between;
          border-bottom: 3px solid #111;
          padding-bottom: 20px;
          margin-bottom: 25px;
        }

        h1 {
          margin: 0 0 8px;
          font-size: 32px;
        }

        h2 {
          margin: 25px 0 12px;
          font-size: 22px;
        }

        h3 {
          margin: 0 0 10px;
          font-size: 14px;
        }

        p {
          margin: 4px 0;
          font-size: 12px;
        }

        .muted {
          color: #666;
        }

        .calendar-grid {
          display: grid;
          grid-template-columns: repeat(7, 1fr);
          gap: 10px;
          margin-bottom: 25px;
        }

        .day-box {
          min-height: 190px;
          border: 1px solid #ccc;
          border-radius: 8px;
          padding: 10px;
          background: #fff;
        }

        .job-card {
          border: 1px solid #ddd;
          border-radius: 6px;
          background: #f7f7f7;
          padding: 8px;
          margin-top: 8px;
          break-inside: avoid;
        }

        .footer {
          margin-top: 30px;
          font-size: 12px;
          color: #555;
          border-top: 1px solid #ddd;
          padding-top: 12px;
        }

        @media print {
          body {
            background: white;
          }

          .page {
            margin: 0;
            max-width: none;
            box-shadow: none;
            padding: 15px;
          }

          .actions,
          button {
            display: none;
          }

          .day-box {
            min-height: 170px;
          }

          .job-card {
            background: white;
          }
        }
      `}</style>

      <div className="actions">
        <button type="button" onClick={() => window.print()}>
          Print Rota
        </button>

        <button
          type="button"
          className="secondary"
          onClick={() => window.history.back()}
        >
          Back
        </button>
      </div>

      <div className="header">
        <div>
          <h1>Scheduled Works Rota</h1>
          <p>
            {formatDate(days[0])} to {formatDate(days[13])}
          </p>
          <p>
            Staff:{" "}
            <strong>{selectedStaff ? selectedStaff.name : "All staff"}</strong>
          </p>
        </div>

        <div>
          <strong>NII Clean Products</strong>
          <p>Works schedule / fortnight rota</p>
        </div>
      </div>

      <h2>Week 1</h2>
      <CalendarWeek weekDays={days.slice(0, 7)} />

      <h2>Week 2</h2>
      <CalendarWeek weekDays={days.slice(7, 14)} />

      <div className="footer">
        Rota generated from Scheduled Works.
      </div>
    </div>
  );
}