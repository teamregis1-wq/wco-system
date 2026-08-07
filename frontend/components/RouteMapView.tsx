"use client";

import { useEffect, useState } from "react";
import { MapContainer, TileLayer, CircleMarker, Polyline, Tooltip, useMap } from "react-leaflet";
import "leaflet/dist/leaflet.css";

interface Stop {
  stop_number: number;
  name: string;
  barangay: string | null;
  lat: number;
  lng: number;
}

interface Props {
  depotLat: number;
  depotLng: number;
  depotName: string;
  stops: Stop[];
  /** Road geometry from OSRM: [[lat, lng], ...] — if provided, draws actual road path */
  geometry?: [number, number][] | null;
}

/** Re-measure the map after the container is resized (expand/collapse). */
function ResizeFix({ expanded }: { expanded: boolean }) {
  const map = useMap();
  useEffect(() => {
    const t = setTimeout(() => map.invalidateSize(), 180);
    if (expanded) map.scrollWheelZoom.enable();
    else map.scrollWheelZoom.disable();
    return () => clearTimeout(t);
  }, [expanded, map]);
  return null;
}

export default function RouteMapView({ depotLat, depotLng, depotName, stops, geometry }: Props) {
  const [expanded, setExpanded] = useState(false);

  // Close the expanded view with Escape
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setExpanded(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);

  // Straight-line fallback: depot → each stop → back to depot
  const straightPath: [number, number][] = [
    [depotLat, depotLng],
    ...stops.map(s => [s.lat, s.lng] as [number, number]),
    [depotLat, depotLng],
  ];

  const allLats = [depotLat, ...stops.map(s => s.lat)];
  const allLngs = [depotLng, ...stops.map(s => s.lng)];
  const centerLat = (Math.min(...allLats) + Math.max(...allLats)) / 2;
  const centerLng = (Math.min(...allLngs) + Math.max(...allLngs)) / 2;

  const roadPath = geometry && geometry.length > 1 ? geometry : null;

  const wrapperStyle: React.CSSProperties = expanded
    ? {
        position: "fixed", inset: 20, zIndex: 12000,
        background: "white", borderRadius: 16, padding: 12,
        boxShadow: "0 12px 48px rgba(0,0,0,0.35)",
        display: "flex", flexDirection: "column",
      }
    : {
        borderRadius: 14, overflow: "hidden",
        border: "1px solid #e2e8f0", marginBottom: 14,
      };

  return (
    <>
      {expanded && (
        <div
          style={{ position: "fixed", inset: 0, zIndex: 11999, background: "rgba(15,23,42,0.45)" }}
          onClick={() => setExpanded(false)}
        />
      )}

      <div style={wrapperStyle}>
        {/* Map — sized by this wrapper; MapContainer props are immutable after mount */}
        <div style={{
          position: "relative",
          flex: expanded ? 1 : undefined,
          height: expanded ? "auto" : 320,
          minHeight: expanded ? 0 : 320,
          borderRadius: expanded ? 12 : 0,
          overflow: "hidden",
        }}>
          <MapContainer
            center={[centerLat, centerLng]}
            zoom={13}
            style={{ height: "100%", width: "100%" }}
            scrollWheelZoom={false}
          >
            <TileLayer
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              attribution='&copy; OpenStreetMap contributors'
            />
            <ResizeFix expanded={expanded} />

            {/* Road-following polyline (OSRM) — solid line */}
            {roadPath && (
              <Polyline
                positions={roadPath}
                pathOptions={{ color: "#0f6e56", weight: 4, opacity: 0.9 }}
              />
            )}

            {/* Straight-line fallback — dashed, shown only if no road geometry */}
            {!roadPath && (
              <Polyline
                positions={straightPath}
                pathOptions={{ color: "#0f6e56", weight: 3, dashArray: "8 4", opacity: 0.75 }}
              />
            )}

            {/* Depot marker */}
            <CircleMarker
              center={[depotLat, depotLng]}
              radius={10}
              pathOptions={{ fillColor: "#0f6e56", color: "white", weight: 2, fillOpacity: 1 }}
            >
              <Tooltip permanent direction="top" offset={[0, -12]}>
                <span style={{ fontSize: 11, fontWeight: 700 }}>{depotName}</span>
              </Tooltip>
            </CircleMarker>

            {/* Stop markers */}
            {stops.map(s => (
              <CircleMarker
                key={s.stop_number}
                center={[s.lat, s.lng]}
                radius={9}
                pathOptions={{ fillColor: "#0369a1", color: "white", weight: 2, fillOpacity: 1 }}
              >
                <Tooltip direction="top" offset={[0, -10]}>
                  <div style={{ fontSize: 11 }}>
                    <strong>#{s.stop_number} {s.name}</strong><br />
                    {s.barangay ?? "—"}
                  </div>
                </Tooltip>
              </CircleMarker>
            ))}
          </MapContainer>

          {/* Expand / collapse control */}
          <button
            type="button"
            className="route-noprint"
            onClick={() => setExpanded(v => !v)}
            title={expanded ? "Collapse map" : "Expand map"}
            style={{
              position: "absolute", top: 10, right: 10, zIndex: 1100,
              fontSize: 12, fontWeight: 600, padding: "6px 12px", borderRadius: 8,
              border: "1px solid #e2e8f0", background: "white", color: "#374151",
              cursor: "pointer", boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
            }}
          >
            {expanded ? "✕ Close" : "⛶ Expand"}
          </button>
        </div>

        {/* Road-following indicator */}
        <div style={{
          padding: "5px 12px", background: roadPath ? "#f0fdf4" : "#fef9ec",
          borderTop: `1px solid ${roadPath ? "#bbf7d0" : "#fde68a"}`,
          fontSize: 11, color: roadPath ? "#166534" : "#92400e", fontWeight: 600,
          borderRadius: expanded ? "0 0 10px 10px" : 0, marginTop: expanded ? 8 : 0,
        }}>
          {roadPath
            ? "✓ Road-following path (OpenStreetMap via OSRM)"
            : "⚠ Straight-line path — OSRM unavailable, showing direct connections"}
          {expanded && <span style={{ marginLeft: 10, color: "#94a3b8", fontWeight: 500 }}>Press Esc or ✕ to close</span>}
        </div>
      </div>
    </>
  );
}
