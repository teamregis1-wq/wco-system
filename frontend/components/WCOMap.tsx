"use client";

/**
 * Self-contained WCO mapping component.
 *
 * Fetches all GIS data internally. Renders:
 *   - Leaflet map with Gi*-scored CircleMarkers
 *   - Toggleable KDE heatmap ImageOverlay (canvas-rendered client-side)
 *   - Right panel: legend, city summary, top-10 hotspot list, forecast chart
 */

import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import {
  MapContainer, TileLayer, CircleMarker, ImageOverlay, Tooltip, useMap,
} from "react-leaflet";
import "leaflet/dist/leaflet.css";
import { getToken } from "@/lib/api";
import ForecastChart from "@/components/ForecastChart";
import type { ForecastPoint } from "@/lib/api";

// ── Types ─────────────────────────────────────────────────────────────────────

interface GiHotspot {
  establishment_id: number;
  name: string;
  latitude: number;
  longitude: number;
  barangay: string | null;
  type: string;
  gi_star_z: number;
  p_value: number;
  category: "high" | "medium" | "low" | "coldspot";
  avg_liters: number;
  record_count: number;
  neighbor_count: number;
}

interface KdeData {
  grid: number[][];
  lat_min: number; lat_max: number;
  lng_min: number; lng_max: number;
  steps: number;
  top_hotspots: TopHotspot[];
  bandwidth_m: number;
}

interface TopHotspot {
  rank: number;
  establishment_id: number;
  name: string;
  barangay: string | null;
  type: string;
  gi_star_z: number;
  avg_liters: number;
  category: string;
}

interface GisSummary {
  total_establishments: number;
  total_wco_per_week: number;
  mean_wco_per_establishment: number;
  hotspot_counts: Record<string, number>;
  by_type: { type: string; count: number; avg_liters_per_week: number; total_liters_per_week: number }[];
}

interface Establishment {
  id: number; name: string; type: string;
  latitude: number; longitude: number; barangay: string | null;
}

type MarkerData = {
  id: number; name: string; type: string;
  latitude: number; longitude: number; barangay: string | null;
  hotspot: GiHotspot | null;
};

// ── Design tokens ─────────────────────────────────────────────────────────────

// Continuous z-score coloring — always produces visible variation even when
// no point clears the 1.96 significance threshold (common with synthetic data).
function zColor(z: number): string {
  if (z >=  2.576) return "#c53030"; // significant hotspot  p < 0.01
  if (z >=  1.960) return "#e53e3e"; // significant hotspot  p < 0.05
  if (z >=  1.200) return "#ed8936"; // trending hotspot
  if (z >=  0.500) return "#f6ad55"; // mild positive
  if (z <= -2.576) return "#1a365d"; // significant coldspot p < 0.01
  if (z <= -1.960) return "#2b6cb0"; // significant coldspot p < 0.05
  if (z <= -1.200) return "#4299e1"; // trending coldspot
  if (z <= -0.500) return "#90cdf4"; // mild negative
  return "#a0aec0";                   // neutral / no pattern
}

function zRadius(z: number): number {
  const a = Math.abs(z);
  if (a >= 2.576) return 14;
  if (a >= 1.960) return 11;
  if (a >= 1.200) return  9;
  if (a >= 0.500) return  7;
  return 5;
}

const CAT_LABEL: Record<string, string> = {
  high:     "High (p < 0.01)",
  medium:   "Medium (p < 0.05)",
  low:      "Not significant",
  coldspot: "Coldspot",
};

const BATANGAS_CENTER: [number, number] = [13.7565, 121.0583];
const BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000/api/v1";

// ── KDE Canvas Renderer ───────────────────────────────────────────────────────

// Threshold raised to 0.13 — cuts the low-density "box" border that appears
// when KDE extends uniformly to grid edges. Edge fade removes the remaining
// rectangular outline by tapering alpha to 0 in the outer 18% of the grid.
function heatRgba(v: number, edgeFade: number): [number, number, number, number] {
  const THRESHOLD = 0.13;
  if (v < THRESHOLD) return [0, 0, 0, 0];

  const t = (v - THRESHOLD) / (1 - THRESHOLD); // remap to [0,1] above cut-off
  // Colour ramp: deep blue → cyan → yellow → red
  type Stop = [number, number, number, number];
  const stops: Stop[] = [
    [0.00,  30,  80, 220],
    [0.30,   0, 210, 210],
    [0.60, 250, 220,   0],
    [1.00, 220,  20,  20],
  ];
  let rv = 220, gv = 20, bv = 20;
  for (let i = 0; i < stops.length - 1; i++) {
    const [t0, r0, g0, b0] = stops[i];
    const [t1, r1, g1, b1] = stops[i + 1];
    if (t >= t0 && t <= t1) {
      const s = (t - t0) / (t1 - t0);
      rv = Math.round(r0 + s * (r1 - r0));
      gv = Math.round(g0 + s * (g1 - g0));
      bv = Math.round(b0 + s * (b1 - b0));
      break;
    }
  }
  // Smooth alpha: power ramp × edge fade — eliminates hard rectangular border
  const alpha = Math.round(Math.pow(t, 0.45) * 175 * edgeFade);
  return [rv, gv, bv, Math.min(alpha, 210)];
}

function kdeToDataUrl(grid: number[][]): string {
  if (!grid.length || !grid[0].length) return "";
  const rows = grid.length;
  const cols = grid[0].length;
  const canvas = document.createElement("canvas");
  canvas.width = cols;
  canvas.height = rows;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(cols, rows);
  const FADE_BAND = 0.18; // outer 18% of grid fades to transparent
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      // Edge-fade factor: 1.0 at center, 0.0 at boundary
      const edgeFade = Math.min(
        r / (rows * FADE_BAND),
        (rows - 1 - r) / (rows * FADE_BAND),
        c / (cols * FADE_BAND),
        (cols - 1 - c) / (cols * FADE_BAND),
        1.0,
      );
      const idx = (r * cols + c) * 4;
      const [rv, gv, bv, av] = heatRgba(grid[r][c], edgeFade);
      img.data[idx]     = rv;
      img.data[idx + 1] = gv;
      img.data[idx + 2] = bv;
      img.data[idx + 3] = av;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL("image/png");
}

// ── API helpers ───────────────────────────────────────────────────────────────

async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getToken()}`,
      ...(options.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail ?? `HTTP ${res.status}`);
  }
  return res.json();
}

// ── Map helpers ───────────────────────────────────────────────────────────────

function FitBounds({ hotspots }: { hotspots: GiHotspot[] }) {
  const map = useMap();
  useEffect(() => {
    if (!hotspots.length) return;
    const lats = hotspots.map(h => h.latitude);
    const lngs = hotspots.map(h => h.longitude);
    map.fitBounds(
      [[Math.min(...lats) - 0.003, Math.min(...lngs) - 0.003],
       [Math.max(...lats) + 0.003, Math.max(...lngs) + 0.003]],
      { padding: [20, 20] }
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hotspots.length]);
  return null;
}

function ResetViewControl({ hotspots, tick }: { hotspots: GiHotspot[]; tick: number }) {
  const map = useMap();
  const prevTick = useRef(0);
  useEffect(() => {
    if (tick === 0 || tick === prevTick.current) return;
    prevTick.current = tick;
    if (!hotspots.length) { map.setView(BATANGAS_CENTER, 14, { animate: true }); return; }
    const lats = hotspots.map(h => h.latitude);
    const lngs = hotspots.map(h => h.longitude);
    map.fitBounds(
      [[Math.min(...lats) - 0.003, Math.min(...lngs) - 0.003],
       [Math.max(...lats) + 0.003, Math.max(...lngs) + 0.003]],
      { padding: [20, 20], animate: true }
    );
  }, [tick, hotspots, map]);
  return null;
}

function FlyToEstab({ id, markers }: { id: number | null; markers: MarkerData[] }) {
  const map = useMap();
  const markersRef = useRef(markers);
  markersRef.current = markers;
  useEffect(() => {
    if (!id) return;
    const m = markersRef.current.find(x => x.id === id);
    if (m) map.flyTo([m.latitude, m.longitude], 17, { animate: true, duration: 1.0 });
  }, [id, map]);
  return null;
}


// ── Main component ────────────────────────────────────────────────────────────

export default function WCOMap() {
  const [hotspots,       setHotspots]       = useState<GiHotspot[]>([]);
  const [kde,            setKde]            = useState<KdeData | null>(null);
  const [summary,        setSummary]        = useState<GisSummary | null>(null);
  const [establishments, setEstablishments] = useState<Establishment[]>([]);

  const [kdeImageUrl, setKdeImageUrl] = useState<string>("");
  const [showKde,     setShowKde]     = useState(false);
  const [loading,     setLoading]     = useState(true);
  const [error,       setError]       = useState<string | null>(null);

  const [selectedId,    setSelectedId]    = useState<number | null>(null);
  const [forecast,      setForecast]      = useState<ForecastPoint[]>([]);
  const [historical,    setHistorical]    = useState<{ week_date: string; quantity_liters: number }[]>([]);
  const [forecasting,   setForecasting]   = useState(false);
  const [forecastError, setForecastError] = useState<string | null>(null);
  const [sidebarOpen,  setSidebarOpen]  = useState(true);
  const [resetTick,    setResetTick]    = useState(0);

  const markers = useMemo<MarkerData[]>(() => {
    const hsMap = new Map(hotspots.map(h => [h.establishment_id, h]));
    return establishments.map(e => ({
      id: e.id, name: e.name, type: e.type,
      latitude: e.latitude, longitude: e.longitude, barangay: e.barangay,
      hotspot: hsMap.get(e.id) ?? null,
    }));
  }, [establishments, hotspots]);

  const sortedEstablishments = useMemo(() =>
    [...establishments].sort((a, b) => a.name.localeCompare(b.name)),
    [establishments]
  );

  // Fetch all GIS data in parallel
  useEffect(() => {
    Promise.all([
      apiFetch<GiHotspot[]>("/gis/hotspots"),
      apiFetch<KdeData>("/gis/kde?steps=60"),
      apiFetch<GisSummary>("/gis/summary"),
      apiFetch<Establishment[]>("/gis/establishments"),
    ])
      .then(([h, k, s, e]) => {
        setHotspots(h);
        setKde(k);
        setSummary(s);
        setEstablishments(e);
      })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  // Render KDE to canvas when data arrives
  useEffect(() => {
    if (!kde?.grid.length) return;
    setKdeImageUrl(kdeToDataUrl(kde.grid));
  }, [kde]);

  async function loadForecast(id: number) {
    setSelectedId(id);
    setForecasting(true);
    setForecast([]);
    setHistorical([]);
    setForecastError(null);
    try {
      const [res, hist] = await Promise.all([
        apiFetch<{ points: ForecastPoint[] }>(`/forecast/${id}?horizon_weeks=12`),
        apiFetch<{ week_date: string; quantity_liters: number }[]>(`/wco/records?establishment_id=${id}`),
      ]);
      setForecast(res.points);
      setHistorical(hist);
    } catch (e) {
      setForecastError(String(e).replace("Error: ", ""));
    } finally {
      setForecasting(false);
    }
  }

  const kdeOverlayBounds: [[number, number], [number, number]] | null =
    kde ? [[kde.lat_min, kde.lng_min], [kde.lat_max, kde.lng_max]] : null;

  return (
    <div style={{ display: "flex", height: "100%", minHeight: 0 }}>
      {/* ── Map ──────────────────────────────────────────────────────────── */}
      <div style={{ flex: 1, position: "relative", minWidth: 0 }}>
        {loading && (
          <div style={{
            position: "absolute", inset: 0, zIndex: 9999,
            background: "rgba(255,255,255,0.85)",
            display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12,
          }}>
            <div style={{ width: 40, height: 40, border: "3px solid #0f6e56", borderTopColor: "transparent", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
            <span style={{ fontSize: 13, color: "#555" }}>Running KDE + Gi* analysis…</span>
          </div>
        )}

        {error && (
          <div style={{
            position: "absolute", top: 10, left: "50%", transform: "translateX(-50%)",
            zIndex: 9999, background: "#fef2f2", border: "1px solid #fca5a5",
            padding: "8px 16px", borderRadius: 10, fontSize: 13, color: "#991b1b",
          }}>
            ⚠ {error}
          </div>
        )}

        <MapContainer
          center={BATANGAS_CENTER}
          zoom={14}
          style={{ height: "100%", width: "100%" }}
          scrollWheelZoom
          zoomControl={true}
        >
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />

          {/* KDE heatmap overlay */}
          {showKde && kdeImageUrl && kdeOverlayBounds && (
            <ImageOverlay
              url={kdeImageUrl}
              bounds={kdeOverlayBounds}
              opacity={0.65}
              zIndex={400}
            />
          )}

          {/* All establishment markers — Gi*-scored where data exists */}
          {markers.map(m => {
            const hs = m.hotspot;
            const isSelected = selectedId === m.id;
            const color  = hs ? zColor(hs.gi_star_z) : "#a0aec0";
            const radius = hs ? zRadius(hs.gi_star_z) : 5;
            return (
              <CircleMarker
                key={m.id}
                center={[m.latitude, m.longitude]}
                radius={isSelected ? radius + 4 : radius}
                pathOptions={{
                  color:       isSelected ? "white" : color,
                  fillColor:   color,
                  fillOpacity: isSelected ? 1 : 0.78,
                  weight:      isSelected ? 3 : 1.5,
                }}
                eventHandlers={{ click: () => loadForecast(m.id) }}
              >
                <Tooltip
                  permanent={isSelected}
                  direction="top"
                  offset={[0, -10]}
                >
                  <div style={{ fontFamily: "system-ui, sans-serif", fontSize: 12, minWidth: 170 }}>
                    <div style={{ fontWeight: 800, marginBottom: 3, color: "#111827", fontSize: 13 }}>{m.name}</div>
                    <div style={{ color: "#6b7280", marginBottom: 4, fontSize: 11 }}>
                      {m.barangay ?? "—"} · <span style={{ textTransform: "capitalize" }}>{m.type.replace(/_/g, " ")}</span>
                    </div>
                    {hs ? (
                      <>
                        <div style={{ display: "flex", gap: 12, marginBottom: 5 }}>
                          <div>
                            <div style={{ fontSize: 10, color: "#9ca3af" }}>Gi* z-score</div>
                            <div style={{ fontWeight: 700, color: zColor(hs.gi_star_z) }}>{hs.gi_star_z.toFixed(3)}</div>
                          </div>
                          <div>
                            <div style={{ fontSize: 10, color: "#9ca3af" }}>p-value</div>
                            <div style={{ fontWeight: 600 }}>{hs.p_value < 0.001 ? "< 0.001" : hs.p_value.toFixed(3)}</div>
                          </div>
                          <div>
                            <div style={{ fontSize: 10, color: "#9ca3af" }}>Avg WCO/wk</div>
                            <div style={{ fontWeight: 700, color: "#0f6e56" }}>{hs.avg_liters.toFixed(1)} L</div>
                          </div>
                        </div>
                        <div style={{
                          padding: "2px 7px", borderRadius: 5, display: "inline-block",
                          background: zColor(hs.gi_star_z) + "22",
                          color: zColor(hs.gi_star_z),
                          fontWeight: 700, fontSize: 10,
                        }}>
                          {CAT_LABEL[hs.category]}
                        </div>
                      </>
                    ) : (
                      <div style={{ fontSize: 11, color: "#94a3b8" }}>No WCO records yet</div>
                    )}
                  </div>
                </Tooltip>
              </CircleMarker>
            );
          })}

          <FitBounds hotspots={hotspots} />
          <FlyToEstab id={selectedId} markers={markers} />
          <ResetViewControl hotspots={hotspots} tick={resetTick} />
        </MapContainer>

        {/* Reset view button */}
        <button
          onClick={() => { setResetTick(t => t + 1); setSelectedId(null); setForecast([]); setHistorical([]); setForecastError(null); }}
          style={{
            position: "absolute", bottom: 24, left: 14, zIndex: 500,
            padding: "7px 14px", borderRadius: 10, border: "1px solid #ccc",
            background: "white", color: "#333",
            fontSize: 12, fontWeight: 700, cursor: "pointer",
            boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
          }}
        >
          ⌖ Reset View
        </button>

        {/* KDE toggle button */}
        <button
          onClick={() => setShowKde(v => !v)}
          style={{
            position: "absolute", bottom: 24, left: 140, zIndex: 500,
            padding: "7px 14px", borderRadius: 10, border: "1px solid #ccc",
            background: showKde ? "#0f6e56" : "white",
            color: showKde ? "white" : "#333",
            fontSize: 12, fontWeight: 700, cursor: "pointer",
            boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
            transition: "all 0.2s ease",
          }}
        >
          {showKde ? "▧ KDE On" : "▨ Show KDE Heatmap"}
        </button>

        {/* Sidebar toggle — lives in map div so it's always visible */}
        <button
          onClick={() => setSidebarOpen(o => !o)}
          title={sidebarOpen ? "Collapse panel" : "Expand panel"}
          style={{
            position: "absolute", right: 0, top: "50%", transform: "translateY(-50%)",
            zIndex: 600, width: 18, height: 52,
            border: "1px solid #e2e8f0", borderRight: "none",
            background: "white", borderRadius: "8px 0 0 8px",
            cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 9, color: "#64748b", boxShadow: "-2px 0 8px rgba(0,0,0,0.08)",
            padding: 0, lineHeight: 1,
          }}
        >
          {sidebarOpen ? "▶" : "◀"}
        </button>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>

      {/* ── Right panel ──────────────────────────────────────────────────── */}
      <aside style={{
        width: sidebarOpen ? 340 : 0,
        minWidth: sidebarOpen ? 340 : 0,
        background: "#f8fafc", borderLeft: sidebarOpen ? "1px solid #e2e8f0" : "none",
        overflowY: sidebarOpen ? "auto" : "hidden",
        overflowX: "hidden",
        display: "flex", flexDirection: "column", gap: 0,
        flexShrink: 0,
        transition: "width 0.25s ease, min-width 0.25s ease",
      }}>
        {/* Legend */}
        <div style={P.section}>
          <div style={P.heading}>Gi* Hotspot Legend</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
            {([
              { z:  2.8, r: 14, label: "Hotspot",          sub: "Gi* z ≥ 2.576  (p < 0.01)" },
              { z:  2.0, r: 11, label: "Moderate hotspot",  sub: "Gi* z ≥ 1.960  (p < 0.05)" },
              { z:  1.4, r:  9, label: "Trending hotspot",  sub: "Gi* z ≥ 1.200" },
              { z:  0.7, r:  7, label: "Mild positive",     sub: "Gi* z ≥ 0.500" },
              { z:  0.0, r:  5, label: "No spatial pattern",sub: "|z| < 0.500" },
              { z: -1.4, r:  9, label: "Trending coldspot", sub: "Gi* z ≤ −1.200" },
              { z: -2.8, r: 14, label: "Coldspot",          sub: "Gi* z ≤ −2.576  (p < 0.01)" },
            ]).map(({ z, r, label, sub }) => (
              <div key={label} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <svg width="28" height="28" style={{ flexShrink: 0 }}>
                  <circle cx="14" cy="14" r={r * 0.85}
                    fill={zColor(z)} fillOpacity={0.82} stroke={zColor(z)} strokeWidth="1.5"
                  />
                </svg>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: "#1a202c" }}>{label}</div>
                  <div style={{ fontSize: 10, color: "#718096" }}>{sub}</div>
                </div>
              </div>
            ))}
          </div>
          {kde && (
            <div style={{ marginTop: 10, padding: "7px 10px", background: "#edf2f7", borderRadius: 8, fontSize: 11, color: "#4a5568" }}>
              KDE bandwidth: <strong>{kde.bandwidth_m.toFixed(0)} m</strong> · Grid: {kde.steps}×{kde.steps}
            </div>
          )}
        </div>

        {/* City summary */}
        {summary && (
          <div style={P.section}>
            <div style={P.heading}>City Summary</div>
            <div style={P.statGrid}>
              <StatBox label="Establishments" value={String(summary.total_establishments)} />
              <StatBox label="Total WCO / week" value={`${summary.total_wco_per_week.toLocaleString()} L`} />
              <StatBox label="Mean per estab." value={`${summary.mean_wco_per_establishment} L`} />
              <StatBox label="Significant hotspots" value={String((summary.hotspot_counts.high ?? 0) + (summary.hotspot_counts.medium ?? 0))} accent />
            </div>

            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#718096", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>
                By establishment type
              </div>
              {summary.by_type.map(t => (
                <div key={t.type} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "5px 0", borderBottom: "1px solid #e2e8f0" }}>
                  <span style={{ fontSize: 12, color: "#4a5568", textTransform: "capitalize" }}>{t.type.replace(/_/g, " ")} ({t.count})</span>
                  <span style={{ fontSize: 12, fontWeight: 700, color: "#2d3748" }}>{t.avg_liters_per_week} L/wk avg</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Establishment selector + Forecast — above Top Hotspots */}
        <div style={P.section}>
          <div style={P.heading}>Select Establishment</div>
          <select
            value={selectedId ?? ""}
            onChange={e => {
              if (!e.target.value) { setSelectedId(null); setForecast([]); setHistorical([]); setForecastError(null); }
              else loadForecast(Number(e.target.value));
            }}
            style={{
              width: "100%", padding: "8px 10px", borderRadius: 8,
              border: "1px solid #e2e8f0", fontSize: 13, background: "white",
              marginBottom: 8, color: "#2d3748", outline: "none",
            }}
          >
            <option value="">— All establishments —</option>
            {sortedEstablishments.map(e => (
              <option key={e.id} value={e.id}>{e.name} ({e.type.replace(/_/g, " ")})</option>
            ))}
          </select>

          {!selectedId && (
            <div style={{ fontSize: 12, color: "#a0aec0" }}>
              Select an establishment to fly to its location and view its 12-week WCO forecast.
            </div>
          )}
          {forecasting && (
            <div style={{ textAlign: "center", padding: "20px 0", color: "#718096", fontSize: 13 }}>Loading forecast…</div>
          )}
          {!forecasting && forecast.length > 0 && <ForecastChart points={forecast} historical={historical} />}
          {!forecasting && !forecast.length && selectedId && (
            <div style={{
              marginTop: 8, padding: "10px 12px", borderRadius: 10,
              background: forecastError ? "#fef2f2" : "#f8fafc",
              border: `1px solid ${forecastError ? "#fca5a5" : "#e2e8f0"}`,
              fontSize: 12,
              color: forecastError ? "#dc2626" : "#94a3b8",
            }}>
              {forecastError ?? "No forecast data."}
            </div>
          )}
        </div>

        {/* Top-10 hotspots */}
        {kde && kde.top_hotspots.length > 0 && (
          <div style={P.section}>
            <div style={P.heading}>Top Hotspots — Gi* Ranking</div>
            {kde.top_hotspots.map(h => (
              <div
                key={h.establishment_id}
                onClick={() => loadForecast(h.establishment_id)}
                style={{
                  display: "flex", alignItems: "center", gap: 10,
                  padding: "8px 0", borderBottom: "1px solid #e2e8f0",
                  cursor: "pointer",
                  background: selectedId === h.establishment_id ? "#f0fdf4" : "transparent",
                  borderRadius: selectedId === h.establishment_id ? 8 : 0,
                  paddingLeft: selectedId === h.establishment_id ? 6 : 0,
                  paddingRight: selectedId === h.establishment_id ? 6 : 0,
                }}
              >
                <div style={{
                  width: 24, height: 24, borderRadius: "50%", flexShrink: 0,
                  background: zColor(h.gi_star_z) ?? "#718096",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: 10, fontWeight: 800, color: "white",
                }}>
                  {h.rank}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: "#1a202c", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {h.name}
                  </div>
                  <div style={{ fontSize: 11, color: "#718096" }}>
                    {h.barangay ?? "—"} · {h.avg_liters} L/wk
                  </div>
                </div>
                <div style={{ textAlign: "right", flexShrink: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 800, color: zColor(h.gi_star_z) ?? "#718096", fontVariantNumeric: "tabular-nums" }}>
                    {h.gi_star_z.toFixed(2)}
                  </div>
                  <div style={{ fontSize: 9, color: "#a0aec0" }}>z-score</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </aside>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function StatBox({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div style={{
      background: accent ? "#f0fdf4" : "white",
      border: `1px solid ${accent ? "#bbf7d0" : "#e2e8f0"}`,
      borderRadius: 10, padding: "10px 12px",
    }}>
      <div style={{ fontSize: 11, color: "#718096", marginBottom: 3 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 800, color: accent ? "#0f6e56" : "#1a202c", fontVariantNumeric: "tabular-nums" }}>{value}</div>
    </div>
  );
}

// ── Panel styles ──────────────────────────────────────────────────────────────

const P: Record<string, React.CSSProperties> = {
  section: {
    padding: "16px",
    borderBottom: "1px solid #e2e8f0",
  },
  heading: {
    fontSize: 12,
    fontWeight: 800,
    color: "#2d3748",
    textTransform: "uppercase",
    letterSpacing: "0.07em",
    marginBottom: 12,
  },
  statGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 8,
  },
};
