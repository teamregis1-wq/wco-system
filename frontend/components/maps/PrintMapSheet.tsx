"use client";

/**
 * Off-screen A4 sheet used only for the hotspot map PDF.
 *
 * It is a separate Leaflet map, sized to the printable page and fitted to every
 * establishment, so the map on screen never moves or resizes during export.
 * `onReady` fires once its tiles have loaded; print CSS in globals.css shows
 * only this sheet while `body.wco-sheet-printing` is set.
 */
import { createPortal } from "react-dom";
import { MapContainer, TileLayer, CircleMarker, ImageOverlay } from "react-leaflet";
import "leaflet/dist/leaflet.css";

export interface SheetMarker { lat: number; lng: number; color: string; radius: number }
export interface LegendItem { color: string; label: string; size: number }

interface Props {
  markers: SheetMarker[];
  kde: { url: string; bounds: [[number, number], [number, number]] } | null;
  title: string;
  subtitle: string;
  legend: LegendItem[];
  note: string;
  onReady: () => void;
}

export default function PrintMapSheet({ markers, kde, title, subtitle, legend, note, onReady }: Props) {
  if (typeof document === "undefined" || !markers.length) return null;
  const lats = markers.map(m => m.lat), lngs = markers.map(m => m.lng);
  const bounds: [[number, number], [number, number]] = [
    [Math.min(...lats) - 0.002, Math.min(...lngs) - 0.002],
    [Math.max(...lats) + 0.002, Math.max(...lngs) + 0.002],
  ];
  const generated = new Date().toLocaleString("en-PH", { year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" });

  return createPortal(
    <div className="wco-print-sheet" aria-hidden>
      <header style={S.header}>
        <div>
          <div style={S.title}>{title}</div>
          <div style={S.subtitle}>{subtitle}</div>
        </div>
        <div style={S.generated}>Generated {generated}</div>
      </header>

      <div style={S.mapBox}>
        <MapContainer
          bounds={bounds}
          boundsOptions={{ padding: [18, 18] }}
          style={{ width: "100%", height: "100%" }}
          zoomControl={false}
          dragging={false}
          scrollWheelZoom={false}
          doubleClickZoom={false}
          touchZoom={false}
          keyboard={false}
          fadeAnimation={false}
          zoomAnimation={false}
        >
          <TileLayer
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            attribution='&copy; OpenStreetMap contributors'
            eventHandlers={{ load: onReady }}
          />
          {kde && <ImageOverlay url={kde.url} bounds={kde.bounds} opacity={0.6} zIndex={400} interactive={false} />}
          {markers.map((m, i) => (
            <CircleMarker key={i} center={[m.lat, m.lng]} radius={m.radius}
              pathOptions={{ color: m.color, fillColor: m.color, fillOpacity: 0.8, weight: 1.5 }} />
          ))}
        </MapContainer>
      </div>

      <footer style={S.footer}>
        <div style={S.legend}>
          {legend.map(l => (
            <span key={l.label} style={S.legendItem}>
              <span style={{ width: l.size, height: l.size, borderRadius: "50%", background: l.color, display: "inline-block", flexShrink: 0 }} />
              {l.label}
            </span>
          ))}
          {kde && (
            <span style={S.legendItem}>
              <span style={{ width: 44, height: 8, borderRadius: 4, display: "inline-block",
                             background: "linear-gradient(90deg, rgb(30,80,220), rgb(0,210,210), rgb(250,220,0), rgb(220,20,20))" }} />
              KDE density (low → high)
            </span>
          )}
        </div>
        <div style={S.note}>{note}</div>
      </footer>
    </div>,
    document.body,
  );
}

const S: Record<string, React.CSSProperties> = {
  header: {
    display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 16,
    paddingBottom: 8, marginBottom: 10, borderBottom: "2px solid #0f6e56",
    fontFamily: "system-ui, -apple-system, sans-serif",
  },
  title: { fontSize: 17, fontWeight: 800, color: "#0b3d30" },
  subtitle: { fontSize: 10.5, color: "#4b6b61", marginTop: 2 },
  generated: { fontSize: 9.5, color: "#6b8a80", textAlign: "right", whiteSpace: "nowrap" },
  mapBox: { width: "100%", height: "7.85in", borderRadius: 6, overflow: "hidden", border: "1px solid #dfe7e3" },
  footer: { marginTop: 10, fontFamily: "system-ui, -apple-system, sans-serif" },
  legend: { display: "flex", flexWrap: "wrap", gap: "6px 16px", fontSize: 10, color: "#1f3d35" },
  legendItem: { display: "inline-flex", alignItems: "center", gap: 6 },
  note: { marginTop: 8, fontSize: 9, color: "#6b8a80", lineHeight: 1.45 },
};
