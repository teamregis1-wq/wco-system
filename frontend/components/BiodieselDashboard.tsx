"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import dynamic from "next/dynamic";
import { getToken } from "@/lib/api";

const Plot = dynamic(() => import("react-plotly.js"), { ssr: false });

// ── Types ─────────────────────────────────────────────────────────────────────

interface SurfaceSlice {
  x: number[]; y: number[]; z: number[][];
  x_label: string; y_label: string; fixed_label: string;
}
interface Optimum {
  temperature_c: number; molar_ratio: number;
  catalyst_loading_pct: number; max_yield_pct: number;
}
interface ActualRun {
  id: number;
  temperature_c: number; molar_ratio: number;
  catalyst_loading_pct: number; yield_pct: number;
  conversion_efficiency: number | null;
  notes: string | null;
}

// ── CSV helpers ───────────────────────────────────────────────────────────────

function parseCSV(text: string): Record<string, string>[] {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map(h => h.trim().replace(/^["']|["']$/g, "").toLowerCase());
  return lines.slice(1).filter(l => l.trim()).map(line => {
    const vals = line.split(",").map(v => v.trim().replace(/^["']|["']$/g, ""));
    const row: Record<string, string> = {};
    headers.forEach((h, i) => { row[h] = vals[i] ?? ""; });
    return row;
  });
}

function mapCSVRow(row: Record<string, string>) {
  const find = (...keys: string[]) => {
    for (const k of keys) {
      const match = Object.entries(row).find(([rk]) => rk.includes(k));
      if (match && match[1]) return match[1];
    }
    return "";
  };
  const temp  = parseFloat(find("temp"));
  const ratio = parseFloat(find("ratio", "molar"));
  const cat   = parseFloat(find("catalyst", "cat"));
  const yld   = parseFloat(find("yield"));
  if ([temp, ratio, cat, yld].some(isNaN)) return null;
  return {
    temperature_c: temp, molar_ratio: ratio,
    catalyst_loading_pct: cat, yield_pct: yld,
    conversion_efficiency: parseFloat(find("conversion", "efficiency")) || null,
    notes: find("notes", "label") || null,
  };
}
interface SurfaceData {
  temp_ratio: SurfaceSlice; temp_catalyst: SurfaceSlice;
  optimum: Optimum; actual_runs: ActualRun[];
}

// ── API ───────────────────────────────────────────────────────────────────────

const BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000/api/v1";

async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(options.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

// ── Precision Slider ──────────────────────────────────────────────────────────

function PrecisionSlider({
  label, unit, value, min, max, step, optimalValue, onChange,
}: {
  label: string; unit: string; value: number; min: number; max: number;
  step: number; optimalValue?: number; onChange: (v: number) => void;
}) {
  const pct = ((value - min) / (max - min)) * 100;
  const optPct = optimalValue != null ? ((optimalValue - min) / (max - min)) * 100 : null;
  const isAtOptimal = optimalValue != null && Math.abs(value - optimalValue) <= step * 0.51;

  const fmt = (v: number) => step < 0.1 ? v.toFixed(2) : step < 1 ? v.toFixed(1) : v.toFixed(0);
  const color = isAtOptimal ? C.amber : C.green;

  return (
    <div style={{ marginBottom: 28 }}>
      {/* Label + value */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 10 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: C.muted, textTransform: "uppercase", letterSpacing: "0.08em" }}>
          {label}
        </span>
        <div style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
          {isAtOptimal && (
            <span style={{ fontSize: 10, fontWeight: 700, color: C.amber, letterSpacing: "0.06em", background: "#fef3c7", padding: "2px 7px", borderRadius: 99 }}>
              OPTIMAL
            </span>
          )}
          <span style={{ fontSize: 22, fontWeight: 800, color, transition: "color 0.3s ease", fontVariantNumeric: "tabular-nums", lineHeight: 1 }}>
            {fmt(value)}
          </span>
          <span style={{ fontSize: 12, color: C.muted, fontWeight: 500 }}>{unit}</span>
        </div>
      </div>

      {/* Track */}
      <div style={{ position: "relative", height: 32, display: "flex", alignItems: "center", overflow: "visible" }}>
        {/* Background track */}
        <div style={{ position: "absolute", left: 0, right: 0, height: 5, background: "#e5e7eb", borderRadius: 99 }}>
          {/* Fill */}
          <div style={{
            position: "absolute", left: 0, width: `${pct}%`, height: "100%", borderRadius: 99,
            background: isAtOptimal ? "linear-gradient(90deg,#d97706,#f59e0b)" : "linear-gradient(90deg,#0f6e56,#17a87a)",
            transition: "width 0.06s linear, background 0.35s ease",
          }} />
          {/* Optimal tick */}
          {optPct != null && (
            <div style={{
              position: "absolute", left: `${optPct}%`, top: "50%",
              transform: "translate(-50%,-50%)",
              width: 2, height: 14, background: C.amber, borderRadius: 1, opacity: 0.9,
            }} />
          )}
        </div>

        {/* Thumb */}
        <div style={{
          position: "absolute", left: `${pct}%`, transform: "translateX(-50%)",
          width: 22, height: 22, background: "white",
          border: `2.5px solid ${color}`,
          borderRadius: "50%", zIndex: 2, pointerEvents: "none",
          boxShadow: isAtOptimal
            ? "0 0 0 4px rgba(217,119,6,0.12), 0 2px 8px rgba(217,119,6,0.25)"
            : "0 0 0 3px rgba(15,110,86,0.08), 0 2px 8px rgba(15,110,86,0.2)",
          transition: "border-color 0.3s ease, box-shadow 0.3s ease",
        }} />

        {/* Invisible input */}
        <input
          type="range" min={min} max={max} step={step} value={value}
          onChange={e => onChange(Number(e.target.value))}
          style={{ position: "absolute", inset: 0, opacity: 0, cursor: "pointer", width: "100%", height: "100%", zIndex: 3, margin: 0 }}
        />
      </div>

      {/* Min / optimal-star / max */}
      <div style={{ position: "relative", marginTop: 5, display: "flex", justifyContent: "space-between" }}>
        <span style={{ fontSize: 10, color: "#d1d5db" }}>{fmt(min)} {unit}</span>
        {optPct != null && optimalValue != null && (
          <span style={{
            position: "absolute", left: `${optPct}%`, transform: "translateX(-50%)",
            fontSize: 10, fontWeight: 700, color: C.amber, whiteSpace: "nowrap", top: 0,
          }}>
            ★ {fmt(optimalValue)} {unit}
          </span>
        )}
        <span style={{ fontSize: 10, color: "#d1d5db" }}>{fmt(max)} {unit}</span>
      </div>
    </div>
  );
}

// ── Animated Yield Number ─────────────────────────────────────────────────────

function YieldDisplay({ value, confidence, predicting }: { value: number | null; confidence: string; predicting: boolean }) {
  const [displayed, setDisplayed] = useState(value);
  const rafRef = useRef<number | null>(null);
  const startRef = useRef<number>(0);
  const fromRef = useRef<number>(displayed ?? 0);

  useEffect(() => {
    if (value == null) return;
    const from = fromRef.current;
    const to = value;
    const duration = 350;
    startRef.current = performance.now();
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    const tick = (now: number) => {
      const t = Math.min((now - startRef.current) / duration, 1);
      const ease = 1 - Math.pow(1 - t, 3);
      const cur = from + (to - from) * ease;
      setDisplayed(cur);
      if (t < 1) rafRef.current = requestAnimationFrame(tick);
      else { fromRef.current = to; setDisplayed(to); }
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [value]);

  const isExtra = confidence === "extrapolation";
  return (
    <div style={{ textAlign: "center", padding: "24px 0 20px" }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: C.muted, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 6 }}>
        Predicted Yield
      </div>
      <div style={{
        fontSize: 64, fontWeight: 900, lineHeight: 1,
        color: isExtra ? "#d97706" : C.green,
        opacity: predicting ? 0.45 : 1,
        transition: "opacity 0.2s ease, color 0.3s ease",
        fontVariantNumeric: "tabular-nums",
        letterSpacing: "-0.02em",
      }}>
        {displayed != null ? displayed.toFixed(2) : "—"}
        <span style={{ fontSize: 28, fontWeight: 700, color: C.muted, marginLeft: 2 }}>%</span>
      </div>
      {confidence && (
        <div style={{ marginTop: 10 }}>
          <span style={{
            display: "inline-block", fontSize: 11, fontWeight: 700, letterSpacing: "0.06em",
            padding: "4px 12px", borderRadius: 99,
            background: isExtra ? "#fef3c7" : "#ecfdf5",
            color: isExtra ? "#92400e" : "#065f46",
          }}>
            {confidence.toUpperCase()}
          </span>
        </div>
      )}
    </div>
  );
}

// ── Main Dashboard ────────────────────────────────────────────────────────────

export default function BiodieselDashboard() {
  const [surface, setSurface] = useState<SurfaceData | null>(null);
  const [surfaceTab, setSurfaceTab] = useState<"temp_ratio" | "temp_catalyst">("temp_ratio");
  const [loadingError, setLoadingError] = useState<string | null>(null);
  const [surfaceLoading, setSurfaceLoading] = useState(true);

  const [temp, setTemp] = useState(55);
  const [ratio, setRatio] = useState(6);
  const [catalyst, setCatalyst] = useState(1.5);

  const [yieldVal, setYieldVal] = useState<number | null>(null);
  const [confidence, setConfidence] = useState("");
  const [predicting, setPredicting] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [deleteConf,   setDeleteConf]   = useState<number | null>(null);
  const [selected,     setSelected]     = useState<Set<number>>(new Set());
  const [batchDelConf, setBatchDelConf] = useState(false);
  const [importing,    setImporting]    = useState(false);
  const [importStatus, setImportStatus] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  function refreshSurface() {
    setSurfaceLoading(true);
    apiFetch<SurfaceData>("/biodiesel/surface?steps=25")
      .then(d => { setSurface(d); setTemp(d.optimum.temperature_c); setRatio(d.optimum.molar_ratio); setCatalyst(d.optimum.catalyst_loading_pct); })
      .catch(e => setLoadingError(String(e)))
      .finally(() => setSurfaceLoading(false));
  }

  async function deleteRun(id: number) {
    try {
      await apiFetch(`/biodiesel/simulations/${id}`, { method: "DELETE" });
      setSurface(prev => prev
        ? { ...prev, actual_runs: prev.actual_runs.filter(r => r.id !== id) }
        : prev
      );
      setDeleteConf(null);
      invalidateAndRefresh();
    } catch (e) { alert(String(e)); }
  }

  function invalidateAndRefresh() {
    // Surface will retrain on next fetch since backend cleared cache
    setTimeout(refreshSurface, 300);
  }

  async function batchDeleteRuns() {
    for (const id of selected) {
      try { await apiFetch(`/biodiesel/simulations/${id}`, { method: "DELETE" }); } catch { /* skip */ }
    }
    setSurface(prev => prev
      ? { ...prev, actual_runs: prev.actual_runs.filter(r => !selected.has(r.id)) }
      : prev
    );
    setSelected(new Set()); setBatchDelConf(false);
    setTimeout(refreshSurface, 300);
  }

  async function handleCSVImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    setImporting(true); setImportStatus(null);
    const text = await file.text();
    const rows = parseCSV(text);
    let ok = 0, skip = 0;
    for (const row of rows) {
      const payload = mapCSVRow(row);
      if (!payload) { skip++; continue; }
      try {
        await apiFetch("/biodiesel/simulations", { method: "POST", body: JSON.stringify(payload) });
        ok++;
      } catch { skip++; }
    }
    setImporting(false);
    setImportStatus(`${ok} row${ok !== 1 ? "s" : ""} imported${skip ? `, ${skip} skipped` : ""}.`);
    if (ok > 0) refreshSurface();
  }


  useEffect(() => {
    setSurfaceLoading(true);
    apiFetch<SurfaceData>("/biodiesel/surface?steps=25")
      .then((data) => {
        setSurface(data);
        setTemp(data.optimum.temperature_c);
        setRatio(data.optimum.molar_ratio);
        setCatalyst(data.optimum.catalyst_loading_pct);
      })
      .catch((e) => setLoadingError(String(e)))
      .finally(() => setSurfaceLoading(false));
  }, []);

  const runPredict = useCallback((t: number, r: number, c: number) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setPredicting(true);
      try {
        const res = await apiFetch<{ predicted_yield_pct: number; confidence: string }>(
          "/biodiesel/predict",
          { method: "POST", body: JSON.stringify({ temperature_c: t, molar_ratio: r, catalyst_loading_pct: c }) }
        );
        setYieldVal(res.predicted_yield_pct);
        setConfidence(res.confidence);
      } catch { /* keep last value */ }
      finally { setPredicting(false); }
    }, 280);
  }, []);

  useEffect(() => { runPredict(temp, ratio, catalyst); }, [temp, ratio, catalyst, runPredict]);


  const slice = surface ? surface[surfaceTab] : null;
  const opt = surface?.optimum;
  const runs = surface?.actual_runs ?? [];

  const plotTraces: Plotly.Data[] = slice
    ? [
        {
          type: "surface", x: slice.x, y: slice.y, z: slice.z,
          colorscale: "Viridis", opacity: 0.88, showscale: true,
          colorbar: { title: "Yield (%)", titlefont: { size: 11 }, thickness: 14, len: 0.65 },
          lighting: { ambient: 0.7, diffuse: 0.8, roughness: 0.5, specular: 0.3 },
          name: "RSM Surface",
        } as Plotly.Data,
        ...(runs.length > 0 ? [{
          type: "scatter3d", mode: "markers",
          x: runs.map(r => r.temperature_c),
          y: surfaceTab === "temp_ratio" ? runs.map(r => r.molar_ratio) : runs.map(r => r.catalyst_loading_pct),
          z: runs.map(r => r.yield_pct),
          marker: { color: runs.map(r => r.yield_pct), colorscale: [[0, "#f59e0b"], [1, "#d97706"]], size: 6, symbol: "circle", line: { color: "white", width: 0.5 } },
          name: "Experimental runs",
          hovertemplate: "T: %{x:.1f}°C<br>%{text}<br>Yield: %{z:.2f}%<extra></extra>",
          text: surfaceTab === "temp_ratio" ? runs.map(r => `Ratio: ${r.molar_ratio}`) : runs.map(r => `Cat: ${r.catalyst_loading_pct}%`),
        } as Plotly.Data] : []),
      ]
    : [];

  return (
    <div style={{ fontFamily: "system-ui,-apple-system,sans-serif", minHeight: "100%", background: "#f3f4f6", display: "flex", flexDirection: "column" }}>
      {/* Page header */}
      <div style={{ padding: "24px 24px 0" }}>
        <h1 style={{ fontSize: 24, fontWeight: 900, color: "#111827", margin: "0 0 4px", letterSpacing: "-0.02em" }}>
          Biodiesel Yield Optimisation
        </h1>
        <p style={{ fontSize: 13, color: "#6b7280", margin: 0 }}>
          Response Surface Methodology · Box-Behnken Design · {runs.length} experimental runs
        </p>
      </div>

      {loadingError && (
        <div style={{ margin: "12px 24px 0", padding: "10px 16px", background: "#fef3c7", border: "1px solid #fcd34d", borderRadius: 10, fontSize: 13, color: "#92400e" }}>
          ⚠ {loadingError.includes("503") ? "RSM model needs simulation data — run python -m app.seed from the backend first." : loadingError}
        </div>
      )}

<div style={{ display: "flex", gap: 16, padding: 24, flex: 1, alignItems: "flex-start", maxWidth: 1400 }}>
        {/* ── Left panel ─────────────────────────────────────── */}
        <div style={{ width: 300, flexShrink: 0, display: "flex", flexDirection: "column", gap: 12 }}>

          {/* Parameters */}
          <div style={S.card}>
            <div style={S.cardHeader}>Parameters</div>
            <PrecisionSlider label="Temperature" unit="°C" value={temp} min={40} max={70} step={0.5} optimalValue={opt?.temperature_c} onChange={setTemp} />
            <PrecisionSlider label="Molar Ratio (MeOH : Oil)" unit=":1" value={ratio} min={1} max={12} step={0.5} optimalValue={opt?.molar_ratio} onChange={setRatio} />
            <PrecisionSlider label="Catalyst Loading" unit="%" value={catalyst} min={0.5} max={3.0} step={0.05} optimalValue={opt?.catalyst_loading_pct} onChange={setCatalyst} />
          </div>

          {/* Yield readout */}
          <div style={{ ...S.card, background: "linear-gradient(135deg,#0f6e56 0%,#0a5240 100%)", border: "none" }}>
            <YieldDisplay value={yieldVal} confidence={confidence} predicting={predicting} />
          </div>

          {/* Optimal conditions */}
          {opt && (
            <div style={S.card}>
              <div style={S.cardHeader}>Optimal Conditions</div>
              {[
                { k: "Temperature", v: `${opt.temperature_c} °C` },
                { k: "Molar Ratio", v: `${opt.molar_ratio} :1` },
                { k: "Catalyst Loading", v: `${opt.catalyst_loading_pct} %` },
                { k: "Maximum Yield", v: `${opt.max_yield_pct} %`, highlight: true },
              ].map(({ k, v, highlight }) => (
                <div key={k} style={{ display: "flex", justifyContent: "space-between", padding: "9px 0", borderBottom: "1px solid #f3f4f6", alignItems: "center" }}>
                  <span style={{ fontSize: 13, color: C.muted }}>{k}</span>
                  <span style={{ fontSize: 14, fontWeight: 700, color: highlight ? C.green : "#111827", fontVariantNumeric: "tabular-nums" }}>{v}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── Right panel ────────────────────────────────────── */}
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 12 }}>

          {/* Surface card */}
          <div style={S.card}>
            {/* Tab bar */}
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 16 }}>
              {([["temp_ratio", "Temp × Molar Ratio"], ["temp_catalyst", "Temp × Catalyst"]] as const).map(([tab, label]) => (
                <button key={tab} onClick={() => setSurfaceTab(tab)} style={{
                  padding: "6px 16px", borderRadius: 99, border: "none", cursor: "pointer", fontSize: 12, fontWeight: 700,
                  transition: "all 0.2s ease",
                  background: surfaceTab === tab ? C.green : "#f3f4f6",
                  color: surfaceTab === tab ? "white" : C.muted,
                  boxShadow: surfaceTab === tab ? "0 2px 8px rgba(15,110,86,0.3)" : "none",
                }}>
                  {label}
                </button>
              ))}
              {slice && <span style={{ marginLeft: "auto", fontSize: 11, color: C.muted, fontStyle: "italic" }}>{slice.fixed_label}</span>}
            </div>

            {surfaceLoading ? (
              <div style={{ height: 440, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, color: C.muted }}>
                <div style={{ width: 36, height: 36, border: `3px solid ${C.green}`, borderTopColor: "transparent", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
                <span style={{ fontSize: 13 }}>Building RSM surface…</span>
              </div>
            ) : slice ? (
              <Plot
                data={plotTraces}
                layout={{
                  autosize: true, height: 440,
                  margin: { t: 10, r: 30, b: 10, l: 10 },
                  scene: {
                    xaxis: { title: { text: slice.x_label, font: { size: 11 } }, tickfont: { size: 10 } },
                    yaxis: { title: { text: slice.y_label, font: { size: 11 } }, tickfont: { size: 10 } },
                    zaxis: { title: { text: "Yield (%)", font: { size: 11 } }, tickfont: { size: 10 } },    
                    bgcolor: "#fafafa",
                    camera: { eye: { x: 1.6, y: 1.6, z: 0.9 } },
                  },
                  paper_bgcolor: "transparent",
                  plot_bgcolor: "transparent",
                  legend: { x: 0.01, y: 0.99, bgcolor: "rgba(255,255,255,0.85)", bordercolor: "#e5e7eb", borderwidth: 1, font: { size: 11 } },
                  font: { family: "system-ui, sans-serif" },
                }}
                config={{ responsive: true, displayModeBar: false, scrollZoom: true }}
                style={{ width: "100%" }}
              />
            ) : (
              <div style={{ height: 440, display: "flex", alignItems: "center", justifyContent: "center", color: C.muted, fontSize: 13 }}>
                Could not load surface data.
              </div>
            )}
          </div>

          {/* Data table */}
          <div style={S.card}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14, flexWrap: "wrap", gap: 8 }}>
              <div>
                <div style={S.cardHeader}>Experimental Data</div>
                <div style={{ fontSize: 11, color: C.muted }}>{runs.length} CHEMCAD simulation run{runs.length !== 1 ? "s" : ""}</div>
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                {importStatus && (
                  <span style={{ fontSize: 11, color: C.green, fontWeight: 600 }}>{importStatus}</span>
                )}
                <input ref={fileRef} type="file" accept=".csv" style={{ display: "none" }} onChange={handleCSVImport} />
                <button
                  onClick={() => { setImportStatus(null); fileRef.current?.click(); }}
                  disabled={importing}
                  style={{ padding: "6px 14px", borderRadius: 8, border: "1px solid #e5e7eb", background: "white", fontSize: 12, fontWeight: 600, cursor: "pointer", color: "#374151", fontFamily: "inherit", opacity: importing ? 0.6 : 1 }}
                >
                  {importing ? "Importing…" : "Import CSV"}
                </button>
              </div>
            </div>

            {/* Batch action bar */}
            {selected.size > 0 && (
              <div style={{ background: "#1a202c", borderRadius: 10, padding: "9px 14px", marginBottom: 12, display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: "white" }}>{selected.size} selected</span>
                <button onClick={() => setSelected(new Set())} style={{ fontSize: 11, color: "#94a3b8", background: "none", border: "none", cursor: "pointer", fontFamily: "inherit" }}>Clear</button>
                <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                  {batchDelConf ? (
                    <>
                      <button onClick={batchDeleteRuns} style={{ fontSize: 11, padding: "5px 12px", borderRadius: 7, border: "none", background: "#dc2626", color: "white", fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
                        Confirm delete {selected.size}
                      </button>
                      <button onClick={() => setBatchDelConf(false)} style={{ fontSize: 11, padding: "5px 12px", borderRadius: 7, border: "1px solid #4a5568", background: "none", color: "#94a3b8", cursor: "pointer", fontFamily: "inherit" }}>Cancel</button>
                    </>
                  ) : (
                    <button onClick={() => setBatchDelConf(true)} style={{ fontSize: 11, padding: "5px 12px", borderRadius: 7, border: "none", background: "#fee2e2", color: "#dc2626", fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
                      Delete {selected.size} selected
                    </button>
                  )}
                </div>
              </div>
            )}

            {runs.length === 0 ? (
              <div style={{ textAlign: "center", padding: "32px 0", color: C.muted, fontSize: 13 }}>
                No data yet — add a run manually or import a CSV.
              </div>
            ) : (
              <div style={{ overflowX: "auto", borderRadius: 10, border: "1px solid #e5e7eb" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: "#f9fafb" }}>
                      <th style={{ padding: "10px 12px", borderBottom: "1px solid #e5e7eb", width: 36 }}>
                        <input type="checkbox"
                          checked={runs.length > 0 && selected.size === runs.length}
                          onChange={() => {
                            if (selected.size === runs.length) setSelected(new Set());
                            else setSelected(new Set(runs.map(r => r.id)));
                          }}
                          style={{ cursor: "pointer" }}
                        />
                      </th>
                      {["#", "Temperature (°C)", "Molar Ratio (:1)", "Catalyst (%)", "Yield (%)", "Conv. Eff. (%)", ""].map(h => (
                        <th key={h} style={{ padding: "10px 16px", textAlign: "left", fontSize: 11, fontWeight: 700, color: C.muted, letterSpacing: "0.04em", textTransform: "uppercase", borderBottom: "1px solid #e5e7eb", whiteSpace: "nowrap" }}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {runs.map((r, i) => {
                      const maxYield = Math.max(...runs.map(x => x.yield_pct));
                      const isMax = r.yield_pct === maxYield;
                      const isDeleting = deleteConf === r.id;
                      return (
                        <tr key={r.id} style={{ background: selected.has(r.id) ? "#eff6ff" : isMax ? "#f0fdf4" : i % 2 === 0 ? "white" : "#fafafa", transition: "background 0.15s" }}>
                          <td style={{ padding: "9px 12px" }}>
                            <input type="checkbox" checked={selected.has(r.id)}
                              onChange={() => setSelected(prev => { const n = new Set(prev); n.has(r.id) ? n.delete(r.id) : n.add(r.id); return n; })}
                              style={{ cursor: "pointer" }} />
                          </td>
                          <td style={{ padding: "9px 16px", color: C.muted, fontVariantNumeric: "tabular-nums" }}>{i + 1}</td>
                          <td style={{ padding: "9px 16px", fontVariantNumeric: "tabular-nums" }}>{r.temperature_c}</td>
                          <td style={{ padding: "9px 16px", fontVariantNumeric: "tabular-nums" }}>{r.molar_ratio}</td>
                          <td style={{ padding: "9px 16px", fontVariantNumeric: "tabular-nums" }}>{r.catalyst_loading_pct}</td>
                          <td style={{ padding: "9px 16px", fontWeight: 700, color: isMax ? C.green : "#374151", fontVariantNumeric: "tabular-nums" }}>
                            {r.yield_pct.toFixed(2)} {isMax && <span style={{ fontSize: 10, color: C.green }}>▲ best</span>}
                          </td>
                          <td style={{ padding: "9px 16px", fontVariantNumeric: "tabular-nums", color: C.muted }}>
                            {r.conversion_efficiency != null ? r.conversion_efficiency.toFixed(2) : "—"}
                          </td>
                          <td style={{ padding: "9px 16px", whiteSpace: "nowrap" }}>
                            {isDeleting ? (
                              <div style={{ display: "flex", gap: 4 }}>
                                <button onClick={() => deleteRun(r.id)} style={{ fontSize: 11, padding: "3px 9px", borderRadius: 6, border: "none", background: "#fee2e2", color: "#dc2626", fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>Confirm</button>
                                <button onClick={() => setDeleteConf(null)} style={{ fontSize: 11, padding: "3px 9px", borderRadius: 6, border: "1px solid #e5e7eb", background: "white", color: "#6b7280", cursor: "pointer", fontFamily: "inherit" }}>Cancel</button>
                              </div>
                            ) : (
                              <button onClick={() => setDeleteConf(r.id)} style={{ fontSize: 11, padding: "3px 9px", borderRadius: 6, border: "1px solid #fca5a5", background: "white", color: "#dc2626", cursor: "pointer", fontFamily: "inherit" }}>Delete</button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Add simulation run */}
          <AddRunForm onAdded={refreshSurface} />
        </div>
      </div>

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

// ── Add simulation run form ───────────────────────────────────────────────────

function AddRunForm({ onAdded }: { onAdded: () => void }) {
  const [open,    setOpen]    = useState(false);
  const [temp,    setTemp]    = useState("");
  const [ratio,   setRatio]   = useState("");
  const [cat,     setCat]     = useState("");
  const [yld,     setYld]     = useState("");
  const [conv,    setConv]    = useState("");
  const [notes,   setNotes]   = useState("");
  const [busy,    setBusy]    = useState(false);
  const [error,   setError]   = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setError(null); setBusy(true);
    try {
      await apiFetch("/biodiesel/simulations", {
        method: "POST",
        body: JSON.stringify({
          temperature_c: parseFloat(temp), molar_ratio: parseFloat(ratio),
          catalyst_loading_pct: parseFloat(cat), yield_pct: parseFloat(yld),
          conversion_efficiency: conv ? parseFloat(conv) : null,
          notes: notes.trim() || null,
        }),
      });
      setTemp(""); setRatio(""); setCat(""); setYld(""); setConv(""); setNotes("");
      setOpen(false); onAdded();
    } catch (err) { setError(String(err).replace("Error: ", "")); }
    finally { setBusy(false); }
  }

  return (
    <div style={{ background: "white", borderRadius: 16, border: "1px solid #e5e7eb", overflow: "hidden", boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{ width: "100%", padding: "14px 20px", background: "none", border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 13, fontWeight: 700, color: C.green, fontFamily: "inherit" }}
      >
        <span>+ Add CHEMCAD / Experimental Run</span>
        <span style={{ fontSize: 16, transform: open ? "rotate(180deg)" : "none", transition: "transform 0.2s" }}>▾</span>
      </button>
      {open && (
        <form onSubmit={submit} style={{ padding: "0 20px 20px", borderTop: "1px solid #f3f4f6" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginTop: 14 }}>
            {[
              { label: "Temperature (°C) *", val: temp, set: setTemp, placeholder: "e.g. 60" },
              { label: "Molar Ratio (:1) *",  val: ratio, set: setRatio, placeholder: "e.g. 6" },
              { label: "Catalyst (%) *",       val: cat,  set: setCat,   placeholder: "e.g. 1.5" },
              { label: "Yield (%) *",          val: yld,  set: setYld,   placeholder: "e.g. 87.4" },
              { label: "Conv. efficiency",      val: conv, set: setConv,  placeholder: "optional" },
              { label: "Label / notes",         val: notes, set: setNotes, placeholder: "e.g. Batch 3 – Jollibee WCO" },
            ].map(({ label, val, set, placeholder }) => (
              <div key={label}>
                <div style={{ fontSize: 11, fontWeight: 700, color: "#6b7280", marginBottom: 4 }}>{label}</div>
                <input
                  style={{ width: "100%", padding: "8px 10px", borderRadius: 8, border: "1.5px solid #e5e7eb", fontSize: 13, outline: "none", boxSizing: "border-box" as const, fontFamily: "inherit" }}
                  type={label.includes("notes") || label.includes("Label") ? "text" : "number"}
                  step="any" value={val} onChange={e => set(e.target.value)}
                  required={label.includes("*")} placeholder={placeholder}
                />
              </div>
            ))}
          </div>
          {error && <div style={{ marginTop: 10, padding: "8px 12px", background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 8, fontSize: 12, color: "#dc2626" }}>{error}</div>}
          <div style={{ marginTop: 12, display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button type="button" onClick={() => setOpen(false)} style={{ padding: "8px 16px", borderRadius: 8, border: "1px solid #e5e7eb", background: "white", fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>Cancel</button>
            <button type="submit" disabled={busy} style={{ padding: "8px 20px", borderRadius: 8, border: "none", background: C.green, color: "white", fontWeight: 700, fontSize: 13, cursor: "pointer", opacity: busy ? 0.7 : 1, fontFamily: "inherit" }}>
              {busy ? "Saving…" : "Save run"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

// ── Design tokens ─────────────────────────────────────────────────────────────

const C = {
  green: "#0f6e56",
  amber: "#d97706",
  muted: "#6b7280",
};

const S: Record<string, React.CSSProperties> = {
  nav: {
    display: "flex", alignItems: "center", gap: 6,
    padding: "12px 24px", background: "white",
    borderBottom: "1px solid #e5e7eb",
    boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
  },
  card: {
    background: "white", borderRadius: 16, padding: 20,
    boxShadow: "0 1px 3px rgba(0,0,0,0.04), 0 4px 16px rgba(0,0,0,0.05)",
    border: "1px solid rgba(0,0,0,0.06)",
  },
  cardHeader: {
    fontSize: 13, fontWeight: 700, color: "#111827",
    marginBottom: 18, letterSpacing: "-0.01em",
  },
  loginCard: {
    background: "white", padding: 36, borderRadius: 20, width: 380,
    boxShadow: "0 20px 60px rgba(0,0,0,0.1), 0 4px 16px rgba(0,0,0,0.06)",
  },
  label: { display: "block", fontSize: 12, fontWeight: 700, color: C.muted, margin: "12px 0 5px", letterSpacing: "0.04em" },
  input: { width: "100%", padding: "10px 12px", borderRadius: 10, border: "1.5px solid #e5e7eb", fontSize: 14, outline: "none", boxSizing: "border-box" as const },
  btn: { width: "100%", padding: "12px", borderRadius: 12, border: "none", background: C.green, color: "white", fontWeight: 700, fontSize: 14, cursor: "pointer", marginTop: 16, letterSpacing: "0.02em" },
};
