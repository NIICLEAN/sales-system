import { json, redirect } from "@remix-run/node";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { Form, useLoaderData } from "@remix-run/react";
import { prisma } from "~/db.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const sales = await prisma.sale.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  const staff = await prisma.staff.findMany({
    orderBy: { name: "asc" },
  });

  const schedules = await prisma.workSchedule.findMany({
    include: {
      sale: true,
      assignedStaff: true,
    },
    orderBy: { scheduledDate: "asc" },
  });

  return json({ sales, staff, schedules });
}

export async function action({ request }: ActionFunctionArgs) {
  const formData = await request.formData();

  await prisma.workSchedule.create({
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

  return (
    <div style={{ padding: 24 }}>
      <h1>Works Schedule</h1>

      <h2>Schedule Works</h2>

      <Form method="post" style={{ display: "grid", gap: 12, maxWidth: 500 }}>
        <label>
          Invoice
          <select name="saleId" required>
            {sales.map((sale) => (
              <option key={sale.id} value={sale.id}>
                Invoice #{sale.id} — {sale.customerName}
              </option>
            ))}
          </select>
        </label>

        <label>
          Work Type
          <select name="workType" required>
            <option value="Repairs">Repairs</option>
            <option value="Fitting">Fitting</option>
            <option value="CustomBuilds">Custom Builds</option>
          </select>
        </label>

        <label>
          Date
          <input type="date" name="scheduledDate" required />
        </label>

        <label>
          Assigned To
          <select name="assignedStaffId" required>
            {staff.map((person) => (
              <option key={person.id} value={person.id}>
                {person.name}
              </option>
            ))}
          </select>
        </label>

        <label>
          Note
          <textarea name="note" rows={4} />
        </label>

        <button type="submit">Schedule Works</button>
      </Form>

      <hr style={{ margin: "32px 0" }} />

      <h2>Calendar</h2>

      <table width="100%" cellPadding="8" border={1}>
        <thead>
          <tr>
            <th>Date</th>
            <th>Invoice</th>
            <th>Customer</th>
            <th>Type</th>
            <th>Assigned To</th>
            <th>Note</th>
          </tr>
        </thead>

        <tbody>
          {schedules.map((item) => (
            <tr key={item.id}>
              <td>{new Date(item.scheduledDate).toLocaleDateString()}</td>
              <td>#{item.sale.id}</td>
              <td>{item.sale.customerName}</td>
              <td>{item.workType}</td>
              <td>{item.assignedStaff.name}</td>
              <td>{item.note}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <button onClick={() => window.print()} style={{ marginTop: 24 }}>
        Print Rota
      </button>
    </div>
  );
}