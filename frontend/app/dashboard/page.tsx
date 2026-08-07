"use client";

import { useEffect, useState } from "react";
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  LineChart, Line, BarChart, Bar,
} from "recharts";
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

interface WeeklyTotal {
  week_date: string;
  total_liters: number;
}

interface WCOSummary {
  month_total_liters: number;
  ytd_total_liters: number;
  current_month: number;
  current_year: number;
  last_updated: string | null;
}
interface TrainingStatus {
  status: string;
  metrics: { mae: number; rmse: number; r2: number; mape: number } | null;
  model_version: string | null;
  trained_at: string | null;
}
interface AggregateForecastPoint {
  week_date: string;
  total_predicted_liters: number;
  establishment_count: number;
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
  const [weekly,   setWeekly]   = useState<WeeklyTotal[]>([]);
  const [wcoSummary,  setWcoSummary]  = useState<WCOSummary | null>(null);
  const [trainStatus, setTrainStatus] = useState<TrainingStatus | null>(null);
  const [aggForecast, setAggForecast] = useState<AggregateForecastPoint[]>([]);
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState<string | null>(null);

  useEffect(() => {
    // Fast calls — summary cards render as soon as these resolve
    Promise.all([
      apiFetch<GisSummary>("/gis/summary").catch(() => null),
      apiFetch<Hotspot[]>("/gis/hotspots").catch(() => [] as Hotspot[]),
      apiFetch<WeeklyTotal[]>("/wco/weekly-totals").catch(() => [] as WeeklyTotal[]),
      apiFetch<WCOSummary>("/wco/summary").catch(() => null),
      apiFetch<TrainingStatus>("/forecast/training-status").catch(() => null),
    ]).then(([s, h, w, ws, ts]) => {
      if (!s) { setError("Could not load dashboard data. Make sure the backend is running."); return; }
      setSummary(s as GisSummary);
      setHotspots(h as Hotspot[]);
      setWeekly(w as WeeklyTotal[]);
      setWcoSummary(ws as WCOSummary | null);
      setTrainStatus(ts as TrainingStatus | null);
    }).finally(() => setLoading(false));

    // Slow call — aggregate LSTM forecast loads independently after the initial render
    apiFetch<AggregateForecastPoint[]>("/forecast/aggregate?horizon_weeks=13")
      .then(af => setAggForecast(af as AggregateForecastPoint[]))
      .catch(() => {});
  }, []);

  if (loading) return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", gap: 12 }}>
      <div style={{ width: 32, height: 32, border: "3px solid #0f6e56", borderTopColor: "transparent", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );

  if (error) return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", padding: 40 }}>
      <div style={{ background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 14, padding: "20px 28px", maxWidth: 480, textAlign: "center" }}>
        <div style={{ fontSize: 24, marginBottom: 10 }}>⚠️</div>
        <div style={{ fontSize: 14, fontWeight: 700, color: "#dc2626", marginBottom: 6 }}>Dashboard unavailable</div>
        <div style={{ fontSize: 13, color: "#64748b" }}>{error}</div>
      </div>
    </div>
  );

  const top5 =[...hotspots].sort((a, b) => b.gi_star_z - a.gi_star_z).slice(0, 5);

  function exportPDF() {
    const el = document.getElementById("dashboard-print-area");
    if (!el) return;

    // Hidden iframe approach: serialises the rendered SVGs into a fresh document
    // (no ID conflicts from duplicate recharts clip/gradient IDs) without opening
    // a new browser tab.
    const iframe = document.createElement("iframe");
    iframe.style.cssText = "position:fixed;left:-9999px;top:0;width:1300px;height:1px;border:none;visibility:hidden;";
    document.body.appendChild(iframe);

    const doc = iframe.contentDocument!;
    doc.open();
    doc.write(`<!DOCTYPE html><html><head>
<style>
  * { box-sizing: border-box; }
  body { margin: 16px 20px; font-family: system-ui, sans-serif; background: white; }
  svg { overflow: visible !important; }
  .recharts-wrapper, .recharts-surface { overflow: visible !important; }
  @media print {
    @page { margin: 1in; size: A4 portrait; }
    body { margin: 0; width: 100%; }
    /* Keep card/chart colours in the printed PDF */
    * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
    /* Reflow wide dashboard grids so nothing is clipped at portrait width */
    .pdf-g5 { grid-template-columns: repeat(2, 1fr) !important; }
    .pdf-g3 { grid-template-columns: repeat(2, 1fr) !important; }
    .pdf-g2 { grid-template-columns: 1fr !important; }
    /* Charts scale down instead of overflowing the page box */
    .recharts-wrapper { width: 100% !important; }
    svg { max-width: 100% !important; height: auto !important; }
    /* Avoid splitting a card across two pages */
    .pdf-g5 > div, .pdf-g3 > div, .pdf-g2 > div { break-inside: avoid; page-break-inside: avoid; }
  }
</style>
</head><body>${el.outerHTML}</body></html>`);
    doc.close();

    setTimeout(() => {
      iframe.contentWindow!.focus();
      iframe.contentWindow!.print();
      setTimeout(() => iframe.remove(), 2000);
    }, 400);
  }

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto", padding: 28 }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 26, fontWeight: 900, color: "#111827", margin: "0 0 4px", letterSpacing: "-0.02em" }}>
            WCO System Overview
          </h1>
          <p style={{ fontSize: 13, color: "#6b7280", margin: 0 }}>
            Batangas City · Live summary from GIS hotspot analysis &amp; LSTM forecasting
          </p>
        </div>
        <button
          onClick={exportPDF}
          style={{ fontSize: 12, padding: "7px 16px", borderRadius: 9, border: "1px solid #e2e8f0", background: "white", cursor: "pointer", color: "#374151", fontWeight: 600, fontFamily: "inherit", flexShrink: 0 }}
        >
          Export PDF
        </button>
      </div>
      <div id="dashboard-print-area">

      {/* ── Row 1: GIS overview (5 cards, fixed columns) ─────────────────── */}
      {summary && (
        <div className="pdf-g5" style={{ display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 12, marginBottom: 12 }}>
          {[
            { label: "Establishments",       value: summary.total_establishments,                                                    unit: "",      color: "#1a202c" },
            { label: "Total WCO / week",     value: summary.total_wco_per_week.toLocaleString(),                                    unit: "L",     color: "#0f6e56" },
            { label: "Avg / establishment",  value: summary.mean_wco_per_establishment,                                             unit: "L/wk",  color: "#1d4ed8" },
            { label: "Significant hotspots", value: (summary.hotspot_counts.high ?? 0) + (summary.hotspot_counts.medium ?? 0),      unit: "",      color: "#dc2626" },
            { label: "Hotspot coverage",     value: `${summary.hotspot_counts.high ?? 0}H / ${summary.hotspot_counts.medium ?? 0}M`,     unit: "",      color: "#7c3aed" },
          ].map(({ label, value, unit, color }) => (
            <div key={label} style={{ background: "white", borderRadius: 14, padding: "14px 16px", boxShadow: "0 1px 3px rgba(0,0,0,0.04),0 4px 12px rgba(0,0,0,0.05)", border: "1px solid rgba(0,0,0,0.06)" }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 5 }}>{label}</div>
              <div style={{ fontSize: 24, fontWeight: 900, color, fontVariantNumeric: "tabular-nums", lineHeight: 1 }}>
                {value}<span style={{ fontSize: 12, fontWeight: 500, color: "#94a3b8", marginLeft: 3 }}>{unit}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Row 2: WCO period summary + LSTM model metrics ───────────────── */}
      <div className="pdf-g2" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
        {/* Period summary */}
        <div style={{ background: "white", borderRadius: 14, padding: "16px 20px", boxShadow: "0 1px 3px rgba(0,0,0,0.04),0 4px 12px rgba(0,0,0,0.05)", border: "1px solid rgba(0,0,0,0.06)" }}>
          <div style={{ fontSize: 10, fontWeight: 800, color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 12 }}>WCO Period Summary</div>
          <div className="pdf-g3" style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 10 }}>
            {wcoSummary ? [
              { label: `This Month (${new Date(wcoSummary.current_year, wcoSummary.current_month - 1).toLocaleString("default", { month: "short" })})`, value: wcoSummary.month_total_liters.toLocaleString(), unit: "L", color: "#0369a1" },
              { label: `YTD ${wcoSummary.current_year}`, value: wcoSummary.ytd_total_liters.toLocaleString(), unit: "L", color: "#7c3aed" },
              { label: "Last Entry", value: wcoSummary.last_updated ? new Date(wcoSummary.last_updated).toLocaleDateString("en-PH", { month: "short", day: "numeric", year: "numeric" }) : "—", unit: "", color: "#374151" },
            ].map(({ label, value, unit, color }) => (
              <div key={label} style={{ background: "#f8fafc", borderRadius: 10, padding: "10px 12px", border: "1px solid #f1f5f9" }}>
                <div style={{ fontSize: 9, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 4 }}>{label}</div>
                <div style={{ fontSize: 18, fontWeight: 900, color, fontVariantNumeric: "tabular-nums", lineHeight: 1 }}>
                  {value}<span style={{ fontSize: 10, fontWeight: 500, color: "#94a3b8", marginLeft: 2 }}>{unit}</span>
                </div>
              </div>
            )) : (
              <div style={{ gridColumn: "1/-1", color: "#94a3b8", fontSize: 12 }}>No WCO data yet.</div>
            )}
          </div>
        </div>

        {/* Model performance */}
        <div style={{ background: "white", borderRadius: 14, padding: "16px 20px", boxShadow: "0 1px 3px rgba(0,0,0,0.04),0 4px 12px rgba(0,0,0,0.05)", border: "1px solid rgba(0,0,0,0.06)" }}>
          <div style={{ fontSize: 10, fontWeight: 800, color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 12 }}>
            LSTM Model Performance
            {trainStatus?.model_version && <span style={{ marginLeft: 6, fontWeight: 500, color: "#cbd5e1" }}>v{trainStatus.model_version}</span>}
          </div>
          {trainStatus?.metrics ? (
            <div className="pdf-g3" style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 10 }}>
              {[
                { label: "MAE",  value: `${trainStatus.metrics.mae}`, unit: "L",  sub: "Mean Abs. Error",     color: "#0f6e56" },
                { label: "RMSE", value: `${trainStatus.metrics.rmse}`, unit: "L", sub: "Root Mean Sq.",       color: "#0f6e56" },
                { label: "R²",   value: trainStatus.metrics.r2 != null ? trainStatus.metrics.r2.toFixed(3) : "—", unit: "", sub: "Goodness of Fit",
                  color: trainStatus.metrics.r2 >= 0.8 ? "#16a34a" : trainStatus.metrics.r2 >= 0.6 ? "#d97706" : "#dc2626" },
              ].map(({ label, value, unit, sub, color }) => (
                <div key={label} style={{ background: "#f8fafc", borderRadius: 10, padding: "10px 12px", border: "1px solid #f1f5f9" }}>
                  <div style={{ fontSize: 9, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 4 }}>{label}</div>
                  <div style={{ fontSize: 18, fontWeight: 900, color, fontVariantNumeric: "tabular-nums", lineHeight: 1 }}>
                    {value}<span style={{ fontSize: 10, fontWeight: 500, color: "#94a3b8", marginLeft: 2 }}>{unit}</span>
                  </div>
                  <div style={{ fontSize: 9, color: "#cbd5e1", marginTop: 2 }}>{sub}</div>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ color: "#94a3b8", fontSize: 12 }}>
              {trainStatus?.status === "not_trained" || !trainStatus
                ? "No trained model yet — go to Admin → Forecasting."
                : `Status: ${trainStatus?.status ?? "unknown"}`}
            </div>
          )}
        </div>
      </div>

      {/* Weekly WCO trend */}
      {weekly.length > 1 && (
        <div style={{ background: "white", borderRadius: 16, padding: 20, marginBottom: 16, boxShadow: "0 1px 3px rgba(0,0,0,0.04),0 4px 12px rgba(0,0,0,0.05)", border: "1px solid rgba(0,0,0,0.06)" }}>
          <div style={{ fontSize: 12, fontWeight: 800, color: "#1a202c", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 16 }}>Weekly WCO Collection Trend</div>
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={weekly.slice(-24)} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="wcoGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#0f6e56" stopOpacity={0.25} />
                  <stop offset="95%" stopColor="#0f6e56" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
              <XAxis
                dataKey="week_date"
                tick={{ fontSize: 10, fill: "#94a3b8" }}
                tickLine={false}
                axisLine={false}
                tickFormatter={d => {
                  const dt = new Date(d);
                  return `${dt.toLocaleString("default", { month: "short" })} ${dt.getDate()}`;
                }}
                interval="preserveStartEnd"
              />
              <YAxis
                tick={{ fontSize: 10, fill: "#94a3b8" }}
                tickLine={false}
                axisLine={false}
                tickFormatter={v => `${v}L`}
                width={48}
              />
              <Tooltip
                formatter={(v: number) => [`${v.toLocaleString(undefined, { maximumFractionDigits: 1 })} L`, "WCO"]}
                labelFormatter={d => {
                  const dt = new Date(d);
                  return dt.toLocaleDateString("en-PH", { year: "numeric", month: "short", day: "numeric" });
                }}
                contentStyle={{ fontSize: 12, borderRadius: 8, border: "1px solid #e2e8f0", boxShadow: "0 2px 8px rgba(0,0,0,0.08)" }}
              />
              <Area
                type="monotone"
                dataKey="total_liters"
                stroke="#0f6e56"
                strokeWidth={2}
                fill="url(#wcoGrad)"
                dot={false}
                activeDot={{ r: 4, fill: "#0f6e56" }}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Aggregate forecasted WCO supply */}
      {aggForecast.length > 0 && (
        <div style={{ background: "white", borderRadius: 16, padding: 20, marginBottom: 16, boxShadow: "0 1px 3px rgba(0,0,0,0.04),0 4px 12px rgba(0,0,0,0.05)", border: "1px solid rgba(0,0,0,0.06)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
            <div style={{ fontSize: 12, fontWeight: 800, color: "#1a202c", textTransform: "uppercase", letterSpacing: "0.06em" }}>3-Month Aggregate WCO Forecast</div>
            <span style={{ fontSize: 11, color: "#94a3b8" }}>{aggForecast[0]?.establishment_count ?? 0} establishments</span>
          </div>
          <ResponsiveContainer width="100%" height={180}>
            <AreaChart data={aggForecast} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="aggGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#7c3aed" stopOpacity={0.2} />
                  <stop offset="95%" stopColor="#7c3aed" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
              <XAxis dataKey="week_date" tick={{ fontSize: 10, fill: "#94a3b8" }} tickLine={false} axisLine={false}
                tickFormatter={d => { const dt = new Date(d); return `${dt.toLocaleString("default", { month: "short" })} ${dt.getDate()}`; }}
                interval="preserveStartEnd" />
              <YAxis tick={{ fontSize: 10, fill: "#94a3b8" }} tickLine={false} axisLine={false} tickFormatter={v => `${v}L`} width={48} />
              <Tooltip
                formatter={(v: number) => [`${v.toLocaleString(undefined, { maximumFractionDigits: 1 })} L`, "Predicted WCO"]}
                labelFormatter={d => new Date(d).toLocaleDateString("en-PH", { year: "numeric", month: "short", day: "numeric" })}
                contentStyle={{ fontSize: 12, borderRadius: 8, border: "1px solid #e2e8f0" }}
              />
              <Area type="monotone" dataKey="total_predicted_liters" stroke="#7c3aed" strokeWidth={2}
                strokeDasharray="6 3" fill="url(#aggGrad)" dot={false} activeDot={{ r: 4 }} />
            </AreaChart>
          </ResponsiveContainer>
          {trainStatus?.model_version && (
            <div style={{ marginTop: 8, fontSize: 10, color: "#94a3b8" }}>
              Model: {trainStatus.model_version}
              {trainStatus.trained_at && ` · Trained ${new Date(trainStatus.trained_at).toLocaleDateString("en-PH", { year: "numeric", month: "short", day: "numeric" })}`}
            </div>
          )}
        </div>
      )}

      <div className="pdf-g2" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
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

        </div>
      </div>
      </div>{/* end dashboard-print-area */}
    </div>
  );
}
