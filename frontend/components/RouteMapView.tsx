"use client";

import { MapContainer, TileLayer, CircleMarker, Polyline, Tooltip } from "react-leaflet";
import "leaflet/dist/leaflet.css";

interface Stop {
  stop_number: number;
  name: string;
  barangay: string | null;
  lat: number;
  lng: number;
  avg_liters: number;
}

interface Props {
  depotLat: number;
  depotLng: number;
  depotName: string;
  stops: Stop[];
  /** Road geometry from OSRM: [[lat, lng], ...] — if provided, draws actual road path */
  geometry?: [number, number][] | null;
}

export default function RouteMapView({ depotLat, depotLng, depotName, stops, geometry }: Props) {
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

  return (
    <div style={{ borderRadius: 14, overflow: "hidden", border: "1px solid #e2e8f0", marginBottom: 14 }}>
      <MapContainer
        center={[centerLat, centerLng]}
        zoom={13}
        style={{ height: 320, width: "100%" }}
        scrollWheelZoom={false}
      >
        <TileLayer
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          attribution='&copy; OpenStreetMap contributors'
        />

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
            <span style={{ fontSize: 11, fontWeight: 700 }}>🏠 {depotName}</span>
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
                {s.barangay} · {s.avg_liters} L avg
              </div>
            </Tooltip>
          </CircleMarker>
        ))}
      </MapContainer>

      {/* Road-following indicator */}
      <div style={{
        padding: "5px 12px", background: roadPath ? "#f0fdf4" : "#fef9ec",
        borderTop: `1px solid ${roadPath ? "#bbf7d0" : "#fde68a"}`,
        fontSize: 11, color: roadPath ? "#166534" : "#92400e", fontWeight: 600,
      }}>
        {roadPath
          ? "✓ Road-following path (OpenStreetMap via OSRM)"
          : "⚠ Straight-line path — OSRM unavailable, showing direct connections"}
      </div>
    </div>
  );
}
