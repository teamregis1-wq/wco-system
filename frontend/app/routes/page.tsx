"use client";

import { useEffect, useState, useCallback } from "react";
import dynamic from "next/dynamic";
import ProtectedRoute from "@/components/ProtectedRoute";
import Navbar from "@/components/Navbar";
import { getToken } from "@/lib/api";

const LocationPicker = dynamic(() => import("@/components/LocationPicker"), { ssr: false });
const RouteMap = dynamic(() => import("@/components/RouteMapView"), { ssr: false });

const BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000/api/v1";

async function apiFetch<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${getToken()}`,
      "Content-Type": "application/json",
      ...(opts.headers as Record<string, string> | undefined),
    },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? `${res.status}`);
  }
  return res.json();
}

interface Establishment {
  id: number;
  name: string;
  wco_code: string;
  barangay: string | null;
  type: string;
  latitude: number;
  longitude: number;
}

interface Hotspot {
  establishment_id: number;
  gi_star_z: number;
  avg_liters: number;
  category: string;
}

interface RouteStop {
  stop_number: number;
  establishment_id: number;
  name: string;
  wco_code: string;
  barangay: string | null;
  avg_liters: number;
  lat: number;
  lng: number;
  leg_distance_km: number;
  cumulative_distance_km: number;
}

interface RouteResult {
  depot_lat: number;
  depot_lng: number;
  depot_name: string;
  stops: RouteStop[];
  total_distance_km: number;
  total_establishments: number;
  estimated_duration_min: number;
  total_wco_liters: number;
  algorithm: string;
  computation_time_ms: number;
  geometry?: [number, number][] | null;
}

interface SavedRoute {
  id: number;
  name: string;
  depot_name: string;
  depot_lat: number;
  depot_lng: number;
  total_distance_km: number;
  total_establishments: number;
  total_wco_liters: number;
  estimated_duration_min: number;
  algorithm: string;
  stops_json: RouteStop[] | null;
  geometry_json: [number, number][] | null;
  created_at: string;
}

export default function RoutesPage() {
  return (
    <ProtectedRoute>
      <div style={{ height: "100vh", display: "flex", flexDirection: "column", fontFamily: "system-ui,-apple-system,sans-serif" }}>
        <Navbar />
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", background: "#f3f4f6" }}>
          <RoutesContent />
        </div>
      </div>
    </ProtectedRoute>
  );
}

type RouteMode = "tsp" | "p2p";

function RoutesContent() {
  const [establishments, setEstablishments] = useState<Establishment[]>([]);
  const [hotspotMap, setHotspotMap] = useState<Map<number, Hotspot>>(new Map());
  const [loadingData, setLoadingData] = useState(true);

  const [mode, setMode] = useState<RouteMode>("tsp");

  const [depotLat, setDepotLat] = useState("13.7565");
  const [depotLng, setDepotLng] = useState("121.0583");
  const [depotName, setDepotName] = useState("Batangas City Hall");

  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [p2pFrom, setP2pFrom] = useState<number | null>(null);
  const [p2pTo,   setP2pTo]   = useState<number | null>(null);
  const [filterText, setFilterText] = useState("");
  const [hotspotOnly, setHotspotOnly] = useState(false);

  const [computing, setComputing] = useState(false);
  const [result, setResult] = useState<RouteResult | null>(null);
  const [p2pResult, setP2pResult] = useState<{ distance_m: number; geometry?: [number,number][] | null } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [history, setHistory] = useState<SavedRoute[]>([]);
  const [loadedRouteId, setLoadedRouteId] = useState<number | null>(null);

  useEffect(() => {
    Promise.all([
      apiFetch<Establishment[]>("/establishments").catch(() => null),
      apiFetch<Hotspot[]>("/gis/hotspots").catch(() => [] as Hotspot[]),
      apiFetch<SavedRoute[]>("/routes/saved").catch(() => [] as SavedRoute[]),
    ]).then(([estabs, hotspots, saved]) => {
      if (!estabs) {
        setError("Could not load establishments. Make sure the backend is running.");
        return;
      }
      setEstablishments(estabs);
      const map = new Map<number, Hotspot>();
      (hotspots as Hotspot[]).forEach(h => map.set(h.establishment_id, h));
      setHotspotMap(map);
      setHistory(saved as SavedRoute[]);
    }).finally(() => setLoadingData(false));
  }, []);

  function loadSavedRoute(r: SavedRoute) {
    setMode("tsp");
    setP2pResult(null);
    setDepotName(r.depot_name);
    setDepotLat(String(r.depot_lat));
    setDepotLng(String(r.depot_lng));
    setLoadedRouteId(r.id);
    setResult({
      depot_lat: r.depot_lat,
      depot_lng: r.depot_lng,
      depot_name: r.depot_name,
      stops: r.stops_json ?? [],
      total_distance_km: r.total_distance_km,
      total_establishments: r.total_establishments,
      estimated_duration_min: r.estimated_duration_min,
      total_wco_liters: r.total_wco_liters,
      algorithm: r.algorithm,
      computation_time_ms: 0,
      geometry: r.geometry_json,
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function deleteSavedRoute(id: number) {
    try {
      await apiFetch(`/routes/saved/${id}`, { method: "DELETE" });
      setHistory(prev => prev.filter(r => r.id !== id));
      if (loadedRouteId === id) setLoadedRouteId(null);
    } catch {
      /* keep the entry if the delete fails */
    }
  }

  const toggleAll = useCallback(() => {
    const visible = filtered();
    const allSelected = visible.every(e => selected.has(e.id));
    setSelected(prev => {
      const next = new Set(prev);
      visible.forEach(e => allSelected ? next.delete(e.id) : next.add(e.id));
      return next;
    });
  }, [selected, establishments, filterText, hotspotOnly, hotspotMap]);

  function filtered() {
    return establishments.filter(e => {
      const matchText = !filterText || e.name.toLowerCase().includes(filterText.toLowerCase()) || e.barangay?.toLowerCase().includes(filterText.toLowerCase());
      const matchHotspot = !hotspotOnly || (hotspotMap.has(e.id) && (hotspotMap.get(e.id)!.category === "high" || hotspotMap.get(e.id)!.category === "medium"));
      return matchText && matchHotspot;
    });
  }

  async function computeRoute() {
    if (selected.size === 0) { setError("Select at least one establishment."); return; }
    const lat = parseFloat(depotLat);
    const lng = parseFloat(depotLng);
    if (isNaN(lat) || isNaN(lng)) { setError("Invalid depot coordinates."); return; }
    setError(null); setComputing(true); setResult(null); setP2pResult(null);
    try {
      const res = await apiFetch<RouteResult>("/routes/collection-route", {
        method: "POST",
        body: JSON.stringify({
          depot_lat: lat, depot_lng: lng,
          depot_name: depotName.trim() || "Depot",
          establishment_ids: Array.from(selected),
        }),
      });
      setResult(res);
      setLoadedRouteId(null);

      // Auto-save into route history (non-blocking; history is best-effort)
      const stamp = new Date().toLocaleString(undefined, {
        month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
      });
      apiFetch<SavedRoute>("/routes/saved", {
        method: "POST",
        body: JSON.stringify({
          name: `${res.depot_name} · ${res.stops.length} stops · ${stamp}`,
          depot_name: res.depot_name,
          depot_lat: res.depot_lat,
          depot_lng: res.depot_lng,
          total_distance_km: res.total_distance_km,
          total_establishments: res.total_establishments,
          total_wco_liters: res.total_wco_liters,
          estimated_duration_min: res.estimated_duration_min,
          algorithm: res.algorithm,
          stops_json: res.stops,
          geometry_json: res.geometry ?? null,
        }),
      }).then(saved => {
        setHistory(prev => [saved, ...prev]);
        setLoadedRouteId(saved.id);
      }).catch(() => {});
    } catch (err) {
      setError(String(err).replace(/^(Type)?Error:\s*/, ""));
    } finally {
      setComputing(false);
    }
  }

  async function computeP2P() {
    if (!p2pFrom || !p2pTo) { setError("Select both a start and end establishment."); return; }
    if (p2pFrom === p2pTo)   { setError("Start and end must be different establishments."); return; }
    setError(null); setComputing(true); setResult(null); setP2pResult(null);
    try {
      const res = await apiFetch<{ total_distance_m: number; geometry?: [number,number][] | null }>(
        `/routes/compute?source_id=${p2pFrom}&target_id=${p2pTo}&algorithm=dijkstra_shortest`,
        { method: "POST" }
      );
      setP2pResult({ distance_m: res.total_distance_m, geometry: res.geometry });
    } catch (err) {
      setError(String(err).replace(/^(Type)?Error:\s*/, ""));
    } finally {
      setComputing(false);
    }
  }

  const visibleEstabs = filtered();

  if (loadingData) return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", gap: 12 }}>
      <div style={{ width: 32, height: 32, border: "3px solid #0f6e56", borderTopColor: "transparent", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto", padding: 28 }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 20 }}>
        <div>
          <h1 style={{ fontSize: 26, fontWeight: 900, color: "#111827", margin: "0 0 4px", letterSpacing: "-0.02em" }}>
            Collection Route Planner
          </h1>
          <p style={{ fontSize: 13, color: "#6b7280", margin: 0 }}>
            Road-following paths via OSRM · OpenStreetMap road network
          </p>
        </div>
        {/* Mode selector */}
        <div style={{ display: "flex", background: "white", border: "1px solid #e2e8f0", borderRadius: 10, padding: 3, gap: 2 }}>
          {([["tsp", "Multi-stop TSP"], ["p2p", "Point-to-Point"]] as [RouteMode, string][]).map(([m, label]) => (
            <button
              key={m}
              onClick={() => { setMode(m); setResult(null); setP2pResult(null); setError(null); }}
              style={{
                fontSize: 12, padding: "6px 14px", borderRadius: 8, border: "none", cursor: "pointer",
                background: mode === m ? "#0f6e56" : "transparent",
                color:      mode === m ? "white"   : "#64748b",
                fontWeight: 700, fontFamily: "inherit",
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1.6fr", gap: 20, alignItems: "start" }}>
        {/* Left panel */}
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

          {/* TSP-only: Depot config + Establishment checkboxes */}
          {mode === "tsp" && (<>
            <div style={{ background: "white", borderRadius: 16, padding: 20, boxShadow: "0 1px 3px rgba(0,0,0,0.04),0 4px 12px rgba(0,0,0,0.05)", border: "1px solid rgba(0,0,0,0.06)" }}>
              <div style={{ fontSize: 12, fontWeight: 800, color: "#1a202c", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 14 }}>Depot / Start Point</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <div>
                  <label style={lbl}>Depot Name</label>
                  <input style={inp} value={depotName} onChange={e => setDepotName(e.target.value)} placeholder="e.g. City Hall" />
                </div>
                <div>
                  <label style={lbl}>Pin location on map</label>
                  <LocationPicker
                    lat={parseFloat(depotLat) || null}
                    lng={parseFloat(depotLng) || null}
                    onChange={(lat, lng) => { setDepotLat(String(lat)); setDepotLng(String(lng)); }}
                  />
                </div>
              </div>
            </div>

            <div style={{ background: "white", borderRadius: 16, padding: 20, boxShadow: "0 1px 3px rgba(0,0,0,0.04),0 4px 12px rgba(0,0,0,0.05)", border: "1px solid rgba(0,0,0,0.06)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                <div style={{ fontSize: 12, fontWeight: 800, color: "#1a202c", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                  Establishments
                </div>
                <span style={{ fontSize: 11, color: "#64748b" }}>{selected.size} selected</span>
              </div>

              <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
                <input
                  style={{ ...inp, flex: 1 }}
                  placeholder="Search name or barangay…"
                  value={filterText}
                  onChange={e => setFilterText(e.target.value)}
                />
                <button
                  onClick={() => setHotspotOnly(v => !v)}
                  style={{
                    fontSize: 11, padding: "5px 10px", borderRadius: 8, cursor: "pointer",
                    background: hotspotOnly ? "#0f6e56" : "white",
                    color: hotspotOnly ? "white" : "#64748b",
                    border: `1px solid ${hotspotOnly ? "#0f6e56" : "#e2e8f0"}`,
                  }}
                >
                  Hotspots only
                </button>
              </div>

              <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
                <button onClick={toggleAll} style={{ fontSize: 11, padding: "4px 10px", borderRadius: 7, cursor: "pointer", background: "white", border: "1px solid #e2e8f0", color: "#374151" }}>
                  {visibleEstabs.every(e => selected.has(e.id)) ? "Deselect all" : "Select all"}
                </button>
                <button onClick={() => setSelected(new Set())} style={{ fontSize: 11, padding: "4px 10px", borderRadius: 7, cursor: "pointer", background: "white", border: "1px solid #e2e8f0", color: "#dc2626" }}>
                  Clear
                </button>
              </div>

              <div style={{ maxHeight: 320, overflowY: "auto", border: "1px solid #e2e8f0", borderRadius: 10 }}>
                {visibleEstabs.length === 0
                  ? <div style={{ padding: 20, textAlign: "center", color: "#94a3b8", fontSize: 12 }}>No establishments found.</div>
                  : visibleEstabs.map((e, i) => {
                    const hs = hotspotMap.get(e.id);
                    const isSelected = selected.has(e.id);
                    return (
                      <label
                        key={e.id}
                        style={{
                          display: "flex", alignItems: "center", gap: 10, padding: "8px 12px",
                          cursor: "pointer", userSelect: "none",
                          background: isSelected ? "#f0fdf4" : (i % 2 === 0 ? "white" : "#fafafa"),
                          borderBottom: i < visibleEstabs.length - 1 ? "1px solid #f1f5f9" : "none",
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => setSelected(prev => {
                            const next = new Set(prev);
                            isSelected ? next.delete(e.id) : next.add(e.id);
                            return next;
                          })}
                          style={{ accentColor: "#0f6e56" }}
                        />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 12, fontWeight: 600, color: "#111827", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.name}</div>
                          <div style={{ fontSize: 10, color: "#94a3b8" }}>{e.barangay ?? "—"} · {e.wco_code}</div>
                        </div>
                        {hs && (
                          <span style={{
                            fontSize: 9, fontWeight: 800, padding: "2px 6px", borderRadius: 99, letterSpacing: "0.04em",
                            background: hs.category === "high" ? "#fee2e2" : hs.category === "medium" ? "#ffedd5" : "#f1f5f9",
                            color: hs.category === "high" ? "#dc2626" : hs.category === "medium" ? "#ea580c" : "#94a3b8",
                          }}>
                            {hs.category.toUpperCase()}
                          </span>
                        )}
                      </label>
                    );
                  })
                }
              </div>
            </div>
          </>)}

          {/* P2P-only: From / To dropdowns */}
          {mode === "p2p" && (
            <div style={{ background: "white", borderRadius: 16, padding: 20, boxShadow: "0 1px 3px rgba(0,0,0,0.04),0 4px 12px rgba(0,0,0,0.05)", border: "1px solid rgba(0,0,0,0.06)" }}>
              <div style={{ fontSize: 12, fontWeight: 800, color: "#1a202c", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>
                Select Establishments
              </div>
              <div style={{ fontSize: 11, color: "#94a3b8", marginBottom: 14 }}>
                Get the exact road distance and path between two points.
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <div>
                  <label style={lbl}>From (start)</label>
                  <select style={inp} value={p2pFrom ?? ""} onChange={e => setP2pFrom(e.target.value ? Number(e.target.value) : null)}>
                    <option value="">— Select establishment —</option>
                    {establishments.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
                  </select>
                </div>
                <div>
                  <label style={lbl}>To (end)</label>
                  <select style={inp} value={p2pTo ?? ""} onChange={e => setP2pTo(e.target.value ? Number(e.target.value) : null)}>
                    <option value="">— Select establishment —</option>
                    {establishments.filter(e => e.id !== p2pFrom).map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
                  </select>
                </div>
              </div>
            </div>
          )}

          {mode === "tsp" ? (
            <button
              onClick={computeRoute}
              disabled={computing || selected.size === 0}
              style={{
                padding: "12px 0", borderRadius: 12, border: "none",
                cursor: computing || selected.size === 0 ? "not-allowed" : "pointer",
                background: computing || selected.size === 0 ? "#94a3b8" : "#0f6e56",
                color: "white", fontSize: 14, fontWeight: 700, letterSpacing: "-0.01em",
                boxShadow: "0 2px 8px rgba(15,110,86,0.3)",
              }}
            >
              {computing ? "Computing route…" : `Compute Route (${selected.size} stops)`}
            </button>
          ) : (
            <button
              onClick={computeP2P}
              disabled={computing || !p2pFrom || !p2pTo}
              style={{
                padding: "12px 0", borderRadius: 12, border: "none",
                cursor: computing || !p2pFrom || !p2pTo ? "not-allowed" : "pointer",
                background: computing || !p2pFrom || !p2pTo ? "#94a3b8" : "#0369a1",
                color: "white", fontSize: 14, fontWeight: 700, letterSpacing: "-0.01em",
                boxShadow: "0 2px 8px rgba(3,105,161,0.3)",
              }}
            >
              {computing ? "Computing…" : "Get Road Distance"}
            </button>
          )}

          {error && (
            <div style={{ padding: "10px 14px", background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 10, fontSize: 13, color: "#dc2626" }}>
              {error}
            </div>
          )}

          {/* Route history */}
          <div style={{ background: "white", borderRadius: 16, padding: 20, boxShadow: "0 1px 3px rgba(0,0,0,0.04),0 4px 12px rgba(0,0,0,0.05)", border: "1px solid rgba(0,0,0,0.06)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 800, color: "#1a202c", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                Route History
              </div>
              <span style={{ fontSize: 11, color: "#64748b" }}>{history.length} saved</span>
            </div>

            {history.length === 0 ? (
              <div style={{ padding: "14px 0", textAlign: "center", color: "#94a3b8", fontSize: 12 }}>
                No routes yet — computed routes are saved here automatically.
              </div>
            ) : (
              <div style={{ maxHeight: 300, overflowY: "auto", display: "flex", flexDirection: "column", gap: 6 }}>
                {history.map(r => {
                  const active = loadedRouteId === r.id;
                  return (
                    <div key={r.id} style={{
                      display: "flex", alignItems: "center", gap: 8,
                      padding: "9px 11px", borderRadius: 10,
                      background: active ? "#f0fdf4" : "#fafafa",
                      border: `1px solid ${active ? "#bbf7d0" : "#f1f5f9"}`,
                    }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12, fontWeight: 700, color: "#111827", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {r.name}
                        </div>
                        <div style={{ fontSize: 10.5, color: "#94a3b8", marginTop: 1 }}>
                          {r.total_establishments} stops · {r.total_distance_km} km · {new Date(r.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                        </div>
                      </div>
                      <button
                        onClick={() => loadSavedRoute(r)}
                        disabled={active}
                        style={{
                          fontSize: 11, fontWeight: 600, padding: "5px 10px", borderRadius: 7,
                          border: "1px solid #d1fae5", cursor: active ? "default" : "pointer",
                          background: active ? "#0f6e56" : "white", color: active ? "white" : "#0f6e56",
                          flexShrink: 0,
                        }}
                      >
                        {active ? "Loaded" : "Load"}
                      </button>
                      <button
                        onClick={() => deleteSavedRoute(r.id)}
                        title="Delete from history"
                        style={{
                          fontSize: 12, padding: "5px 8px", borderRadius: 7,
                          border: "1px solid #fecaca", cursor: "pointer",
                          background: "white", color: "#dc2626", flexShrink: 0,
                        }}
                      >
                        ✕
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Right panel: results */}
        <div>
          {/* Point-to-point result */}
          {p2pResult && !result && (() => {
            const fromE = establishments.find(e => e.id === p2pFrom);
            const toE   = establishments.find(e => e.id === p2pTo);
            const distKm = (p2pResult.distance_m / 1000).toFixed(2);
            const estMin = Math.round(p2pResult.distance_m / 1000 / 30 * 60);
            return (
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <div style={{ background: "white", borderRadius: 16, padding: 20, boxShadow: "0 1px 3px rgba(0,0,0,0.04),0 4px 12px rgba(0,0,0,0.05)", border: "1px solid rgba(0,0,0,0.06)" }}>
                  <div style={{ fontSize: 12, fontWeight: 800, color: "#1a202c", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 14 }}>Road Distance</div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 14 }}>
                    {[
                      { label: "Distance", value: distKm, unit: "km",  color: "#0369a1" },
                      { label: "Est. travel", value: `${estMin}`, unit: "min", color: "#d97706" },
                    ].map(({ label, value, unit, color }) => (
                      <div key={label} style={{ background: "#f8fafc", borderRadius: 12, padding: "14px 16px", border: "1px solid #e2e8f0" }}>
                        <div style={{ fontSize: 10, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>{label}</div>
                        <div style={{ fontSize: 22, fontWeight: 900, color, fontVariantNumeric: "tabular-nums" }}>
                          {value}<span style={{ fontSize: 12, fontWeight: 500, color: "#94a3b8", marginLeft: 3 }}>{unit}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                  <div style={{ fontSize: 12, color: "#64748b", marginBottom: 12 }}>
                    <span style={{ fontWeight: 700, color: "#111827" }}>{fromE?.name ?? "Start"}</span>
                    <span style={{ margin: "0 8px", color: "#94a3b8" }}>→</span>
                    <span style={{ fontWeight: 700, color: "#111827" }}>{toE?.name ?? "End"}</span>
                  </div>
                </div>
                {fromE && toE && (
                  <RouteMap
                    depotLat={fromE.latitude}
                    depotLng={fromE.longitude}
                    depotName={fromE.name}
                    stops={[{ stop_number: 1, name: toE.name, barangay: toE.barangay, lat: toE.latitude, lng: toE.longitude }]}
                    geometry={p2pResult.geometry}
                  />
                )}
              </div>
            );
          })()}

          {!result && !p2pResult && (
            <div style={{ background: "white", borderRadius: 16, padding: 40, textAlign: "center", boxShadow: "0 1px 3px rgba(0,0,0,0.04),0 4px 12px rgba(0,0,0,0.05)", border: "1px solid rgba(0,0,0,0.06)", color: "#94a3b8", fontSize: 14 }}>
              {mode === "tsp"
                ? "Select establishments and click Compute Route to see the optimised collection order."
                : "Select a start and end establishment to get the road distance between them."}
            </div>
          )}

          {result && (() => {
            function exportRoutePDF() {
              const style = document.createElement("style");
              style.id = "__route-print-style";
              style.textContent = `
                @media print {
                  @page { margin: 1in; size: A4 portrait; }
                  body * { visibility: hidden !important; }
                  #route-print-area, #route-print-area * { visibility: visible !important; }
                  #route-print-area {
                    position: fixed !important;
                    top: 0 !important;
                    left: 0 !important;
                    padding: 0 !important;
                    background: white !important;
                    width: 100% !important;
                    font-family: system-ui, sans-serif !important;
                  }
                  .route-print-header { display: block !important; }
                  .route-map-wrapper { height: 240px !important; overflow: hidden !important; }
                  .route-map-wrapper * { visibility: visible !important; }
                  .leaflet-container { height: 240px !important; }
                  /* Keep card colours and reflow the summary grid for portrait width */
                  #route-print-area * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
                  .route-summary-grid { grid-template-columns: repeat(2, 1fr) !important; }
                  #route-print-area table { width: 100% !important; font-size: 11px !important; }
                  #route-print-area tr { break-inside: avoid; page-break-inside: avoid; }
                  .route-noprint { display: none !important; }
                }
              `;
              document.head.appendChild(style);
              window.print();
              setTimeout(() => document.getElementById("__route-print-style")?.remove(), 1500);
            }
            return (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }} id="route-print-area">
              {/* Print-only header */}
              <div className="route-print-header" style={{ display: "none", marginBottom: 4 }}>
                <div style={{ fontSize: 16, fontWeight: 900, color: "#111827", marginBottom: 2 }}>
                  WCO Collection Route — {result.depot_name}
                </div>
                <div style={{ fontSize: 11, color: "#64748b" }}>
                  {result.total_establishments} stops · {result.total_distance_km} km · Algorithm: {result.algorithm}
                </div>
              </div>
              {/* Summary cards */}
              <div className="route-summary-grid" style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12 }}>
                {[
                  { label: "Stops",        value: result.total_establishments,                               unit: "",     color: "#1a202c" },
                  { label: "Distance",     value: result.total_distance_km.toFixed(1),                       unit: "km",   color: "#0369a1" },
                  { label: "Est. duration",value: `${Math.round(result.estimated_duration_min / 60)}h ${Math.round(result.estimated_duration_min % 60)}m`, unit: "", color: "#d97706" },
                  { label: "Total WCO",    value: result.total_wco_liters.toLocaleString(undefined, { maximumFractionDigits: 1 }), unit: "L", color: "#0f6e56" },
                ].map(({ label, value, unit, color }) => (
                  <div key={label} style={{ background: "white", borderRadius: 14, padding: "14px 16px", boxShadow: "0 1px 3px rgba(0,0,0,0.04),0 4px 12px rgba(0,0,0,0.05)", border: "1px solid rgba(0,0,0,0.06)" }}>
                    <div style={{ fontSize: 10, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>{label}</div>
                    <div style={{ fontSize: 22, fontWeight: 900, color, fontVariantNumeric: "tabular-nums", lineHeight: 1 }}>
                      {value}<span style={{ fontSize: 12, fontWeight: 500, color: "#94a3b8", marginLeft: 3 }}>{unit}</span>
                    </div>
                  </div>
                ))}
              </div>

              {/* Algorithm + computation time */}
              <div style={{ fontSize: 11, color: "#94a3b8", marginBottom: 4 }}>
                Algorithm: <span style={{ color: "#374151", fontWeight: 600 }}>{result.algorithm}</span>
                {result.computation_time_ms > 0
                  ? <>&nbsp;·&nbsp;Computed in <span style={{ color: "#374151", fontWeight: 600 }}>{result.computation_time_ms} ms</span></>
                  : <>&nbsp;·&nbsp;<span style={{ color: "#374151", fontWeight: 600 }}>Loaded from history</span></>
                }
              </div>

              <div className="route-map-wrapper">
                <RouteMap
                  depotLat={result.depot_lat}
                  depotLng={result.depot_lng}
                  depotName={result.depot_name}
                  stops={result.stops}
                  geometry={result.geometry}
                />
              </div>

              {/* Route stops table */}
              <div style={{ background: "white", borderRadius: 16, overflow: "hidden", boxShadow: "0 1px 3px rgba(0,0,0,0.04),0 4px 12px rgba(0,0,0,0.05)", border: "1px solid rgba(0,0,0,0.06)" }}>
                <div style={{ padding: "16px 20px", borderBottom: "1px solid #f1f5f9", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div style={{ fontSize: 12, fontWeight: 800, color: "#1a202c", textTransform: "uppercase", letterSpacing: "0.06em" }}>Optimised Stop Order</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <span style={{ fontSize: 11, color: "#94a3b8" }}>Depot: {result.depot_name}</span>
                    <button
                      className="route-noprint"
                      onClick={exportRoutePDF}
                      style={{ fontSize: 11, padding: "5px 12px", borderRadius: 8, border: "1px solid #e2e8f0", background: "white", cursor: "pointer", color: "#374151", fontWeight: 600, fontFamily: "inherit" }}
                    >
                      Export PDF
                    </button>
                  </div>
                </div>
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                    <thead>
                      <tr style={{ background: "#f8fafc" }}>
                        {["#", "Code", "Establishment", "Barangay", "Leg (km)", "Cumul. (km)"].map(h => (
                          <th key={h} style={{ padding: "9px 14px", textAlign: "left", fontSize: 10, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.05em", borderBottom: "1px solid #e2e8f0", whiteSpace: "nowrap" }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {result.stops.map((s, i) => (
                        <tr key={s.establishment_id} style={{ background: i % 2 === 0 ? "white" : "#fafafa" }}>
                          <td style={{ padding: "10px 14px", borderBottom: "1px solid #f1f5f9" }}>
                            <div style={{ width: 24, height: 24, borderRadius: "50%", background: "#0f6e56", color: "white", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 800 }}>
                              {s.stop_number}
                            </div>
                          </td>
                          <td style={{ padding: "10px 14px", borderBottom: "1px solid #f1f5f9", fontFamily: "monospace", fontWeight: 700, color: "#0f6e56", fontSize: 12 }}>{s.wco_code}</td>
                          <td style={{ padding: "10px 14px", borderBottom: "1px solid #f1f5f9", fontWeight: 600, color: "#111827", maxWidth: 220 }}>
                            <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.name}</div>
                          </td>
                          <td style={{ padding: "10px 14px", borderBottom: "1px solid #f1f5f9", color: "#64748b" }}>{s.barangay ?? "—"}</td>
                          <td style={{ padding: "10px 14px", borderBottom: "1px solid #f1f5f9", fontVariantNumeric: "tabular-nums", color: "#374151" }}>{s.leg_distance_km}</td>
                          <td style={{ padding: "10px 14px", borderBottom: "1px solid #f1f5f9", fontVariantNumeric: "tabular-nums", color: "#64748b" }}>{s.cumulative_distance_km}</td>
                        </tr>
                      ))}
                      <tr style={{ background: "#f8fafc" }}>
                        <td colSpan={4} style={{ padding: "10px 14px", fontSize: 11, color: "#94a3b8", fontStyle: "italic" }}>Return to {result.depot_name}</td>
                        <td colSpan={2} style={{ padding: "10px 14px", fontWeight: 700, color: "#0369a1", fontVariantNumeric: "tabular-nums" }}>{result.total_distance_km} km total</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
            );
          })()}
        </div>
      </div>
    </div>
  );
}

const lbl: React.CSSProperties = {
  display: "block", fontSize: 10, fontWeight: 700, color: "#64748b",
  textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 4,
};

const inp: React.CSSProperties = {
  width: "100%", padding: "7px 10px", fontSize: 13, borderRadius: 8,
  border: "1px solid #e2e8f0", outline: "none", boxSizing: "border-box",
  fontFamily: "inherit", color: "#111827",
};
