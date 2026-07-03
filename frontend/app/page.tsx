"use client";

import dynamic from "next/dynamic";
import Navbar from "@/components/Navbar";

const WCOMap = dynamic(() => import("@/components/WCOMap"), {
  ssr: false,
  loading: () => (
    <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "#718096", fontSize: 14 }}>
      Loading map…
    </div>
  ),
});

export default function MappingPage() {
  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", fontFamily: "system-ui, -apple-system, sans-serif" }}>
      <Navbar />
      <div style={{ flex: 1, minHeight: 0 }}>
        <WCOMap />
      </div>
    </div>
  );
}
