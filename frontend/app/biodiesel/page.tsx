import ProtectedRoute from "@/components/ProtectedRoute";
import BiodieselDashboard from "@/components/BiodieselDashboard";
import Navbar from "@/components/Navbar";

export default function BiodieselPage() {
  return (
    <ProtectedRoute>
      <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", fontFamily: "system-ui, -apple-system, sans-serif" }}>
        <Navbar />
        <div style={{ flex: 1 }}>
          <BiodieselDashboard />
        </div>
      </div>
    </ProtectedRoute>
  );
}
