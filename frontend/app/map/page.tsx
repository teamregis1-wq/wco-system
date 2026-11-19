"use client";

import dynamic from "next/dynamic";
import ProtectedRoute from "@/components/auth/ProtectedRoute";
import Navbar from "@/components/layout/Navbar";

const WCOMap = dynamic(() => import("@/components/maps/WCOMap"), {
  ssr: false,
  loading: () => (
    <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "#718096", fontSize: 14 }}>
      Loading map…
    </div>
  ),
});

export default function MappingPage() {
  return (
    <ProtectedRoute>
      <div className="wco-map-page wco-app-bg" style={{ height: "100vh", display: "flex", flexDirection: "column", fontFamily: "system-ui, -apple-system, sans-serif" }}>
        <Navbar />
        <div className="wco-map-body" style={{ flex: 1, minHeight: 0 }}>
          <WCOMap />
        </div>
      </div>
    </ProtectedRoute>
  );
}
