"use client";

import { useEffect, useState } from "react";
import ProtectedRoute from "@/components/ProtectedRoute";
import Navbar from "@/components/Navbar";
import { getToken } from "@/lib/api";

const BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000/api/v1";

async function apiFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${getToken()}` },
  });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

interface GisSummary {
  total_establishments: number;
  total_wco_per_week: number;
  mean_wco_per_establishment: number;
  hotspot_counts: Record<string, number>;
  by_type: { type: string; count: number; avg_liters_per_week: number }[];
}

interface Hotspot {
  establishment_id: number;
  name: string;
  barangay: string | null;
  type: string;
  gi_star_z: number;
  avg_liters: number;
  category: string;
}

interface Optimum {
  max_yield_pct: number;
  temperature_c: number;
  molar_ratio: number;
  catalyst_loading_pct: number;
}

function zColor(z: number) {
  if (z >= 2.576) return "#c53030";
  if (z >= 1.96)  return "#e53e3e";
  if (z >= 1.2)   return "#ed8936";
  if (z >= 0.5)   return "#f6ad55";
  return "#a0aec0";
}

export default function DashboardPage() {
  return (
    <ProtectedRoute>
      <div style={{ height: "100vh", display: "flex", flexDirection: "column", fontFamily: "system-ui,-apple-system,sans-serif" }}>
        <Navbar />
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", background: "#f3f4f6" }}>
          <DashboardContent />
        </div>
      </div>
    </ProtectedRoute>
  );
}

function DashboardContent() {
  const [summary,  setSummary]  = useState<GisSummary | null>(null);
  const [hotspots, setHotspots] = useState<Hotspot[]>([]);
  const [optimum,  setOptimum]  = useState<Optimum | null>(null);
  const [loading,  setLoading]  = useState(true);

  useEffect(() => {
    Promise.all([
      apiFetch<GisSummary>("/gis/summary"),
      apiFetch<Hotspot[]>("/gis/hotspots"),
      apiFetch<{ optimum: Optimum }>("/biodiesel/surface?steps=5")
        .then(d => d.optimum).catch(() => null),
    ]).then(([s, h, o]) => {
      setSummary(s); setHotspots(h); setOptimum(o);
    }).finally(() => setLoading(false));
  }, []);

  if (loading) return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", gap: 12 }}>
      <div style={{ width: 32, height: 32, border: "3px solid #0f6e56", borderTopColor: "transparent", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );

  const projectedBiodiesel = summary && optimum
    ? summary.total_wco_per_week * optimum.max_yield_pct / 100
    : null;

  const top5 = [...hotspots].sort((a, b) => b.gi_star_z - a.gi_star_z).slice(0, 5);

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto", padding: 28 }}>
      <h1 style={{ fontSize: 26, fontWeight: 900, color: "#111827", margin: "0 0 4px", letterSpacing: "-0.02em" }}>
        WCO System Overview
      </h1>
      <p style={{ fontSize: 13, color: "#6b7280", margin: "0 0 24px" }}>
        Batangas City · Live summary from GIS analysis &amp; RSM model
      </p>

      {/* Key metric cards */}
      {summary && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))", gap: 14, marginBottom: 24 }}>
          {[
            { label: "Establishments", value: summary.total_establishments, unit: "", color: "#1a202c" },
            { label: "Total WCO / week", value: summary.total_wco_per_week.toLocaleString(), unit: "L", color: "#0f6e56" },
            { label: "Avg per establishment", value: summary.mean_wco_per_establishment, unit: "L/wk", color: "#1d4ed8" },
            { label: "Significant hotspots", value: (summary.hotspot_counts.high ?? 0) + (summary.hotspot_counts.medium ?? 0), unit: "", color: "#dc2626" },
            ...(projectedBiodiesel != null ? [{ label: "Projected biodiesel", value: Math.round(projectedBiodiesel).toLocaleString(), unit: "L/wk", color: "#d97706" }] : []),
          ].map(({ label, value, unit, color }) => (
            <div key={label} style={{ background: "white", borderRadius: 14, padding: "16px 20px", boxShadow: "0 1px 3px rgba(0,0,0,0.04), 0 4px 12px rgba(0,0,0,0.05)", border: "1px solid rgba(0,0,0,0.06)" }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>{label}</div>
              <div style={{ fontSize: 28, fontWeight: 900, color, fontVariantNumeric: "tabular-nums", lineHeight: 1 }}>
                {value}<span style={{ fontSize: 14, fontWeight: 500, color: "#94a3b8", marginLeft: 4 }}>{unit}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        {/* Top 5 hotspots */}
        <div style={{ background: "white", borderRadius: 16, padding: 20, boxShadow: "0 1px 3px rgba(0,0,0,0.04),0 4px 12px rgba(0,0,0,0.05)", border: "1px solid rgba(0,0,0,0.06)" }}>
          <div style={{ fontSize: 12, fontWeight: 800, color: "#1a202c", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 16 }}>Top 5 Hotspots</div>
          {top5.length === 0
            ? <div style={{ color: "#94a3b8", fontSize: 13 }}>No hotspot data yet.</div>
            : top5.map((h, i) => (
              <div key={h.establishment_id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "9px 0", borderBottom: i < 4 ? "1px solid #f1f5f9" : "none" }}>
                <div style={{ width: 26, height: 26, borderRadius: "50%", background: zColor(h.gi_star_z), display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 800, color: "white", flexShrink: 0 }}>
                  {i + 1}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "#111827", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{h.name}</div>
                  <div style={{ fontSize: 11, color: "#94a3b8" }}>{h.barangay ?? "—"} · {h.avg_liters.toFixed(1)} L/wk</div>
                </div>
                <div style={{ textAlign: "right", flexShrink: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 800, color: zColor(h.gi_star_z), fontVariantNumeric: "tabular-nums" }}>{h.gi_star_z.toFixed(2)}</div>
                  <div style={{ fontSize: 9, color: "#a0aec0" }}>z-score</div>
                </div>
              </div>
            ))
          }
        </div>

        {/* WCO by type + RSM optimal */}
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {summary && (
            <div style={{ background: "white", borderRadius: 16, padding: 20, boxShadow: "0 1px 3px rgba(0,0,0,0.04),0 4px 12px rgba(0,0,0,0.05)", border: "1px solid rgba(0,0,0,0.06)" }}>
              <div style={{ fontSize: 12, fontWeight: 800, color: "#1a202c", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 14 }}>WCO by Type</div>
              {summary.by_type.map(t => (
                <div key={t.type} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "7px 0", borderBottom: "1px solid #f1f5f9" }}>
                  <div>
                    <span style={{ fontSize: 13, color: "#374151", textTransform: "capitalize" }}>{t.type.replace(/_/g, " ")}</span>
                    <span style={{ fontSize: 11, color: "#94a3b8", marginLeft: 6 }}>{t.count} establishments</span>
                  </div>
                  <span style={{ fontSize: 13, fontWeight: 700, color: "#0f6e56", fontVariantNumeric: "tabular-nums" }}>{t.avg_liters_per_week} L/wk avg</span>
                </div>
              ))}
            </div>
          )}

          {optimum && (
            <div style={{ background: "linear-gradient(135deg,#0f6e56,#0a5240)", borderRadius: 16, padding: 20 }}>
              <div style={{ fontSize: 12, fontWeight: 800, color: "rgba(255,255,255,0.7)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 14 }}>RSM Optimal Conditions</div>
              {[
                { k: "Temperature", v: `${optimum.temperature_c} °C` },
                { k: "Molar Ratio",  v: `${optimum.molar_ratio} :1` },
                { k: "Catalyst",     v: `${optimum.catalyst_loading_pct} %` },
                { k: "Max Yield",    v: `${optimum.max_yield_pct} %` },
              ].map(({ k, v }) => (
                <div key={k} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid rgba(255,255,255,0.1)" }}>
                  <span style={{ fontSize: 13, color: "rgba(255,255,255,0.65)" }}>{k}</span>
                  <span style={{ fontSize: 13, fontWeight: 700, color: "white" }}>{v}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
