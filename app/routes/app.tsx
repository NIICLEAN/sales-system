import { Outlet, Link } from "react-router";

export default function AppLayout() {
  return (
    <div style={{ display: "flex", height: "100%" }}>
      
      {/* Sidebar */}
      <div style={{ width: 200, padding: 20, background: "#f4f6f8" }}>
        <h3>NCP Sales</h3>

        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <Link to="/app/invoice">Invoice</Link>
          <Link to="/app/invoices">Invoices</Link>
          <Link to="/app/quotes">Quotes</Link>
          <Link to="/app/reports">Reports</Link>
          <Link to="/app/staff">Staff</Link>
        </div>
      </div>

      {/* Page Content */}
      <div style={{ flex: 1, padding: 20 }}>
        <Outlet />
      </div>
    </div>
  );
}