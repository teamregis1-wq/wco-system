"use client";

import { useEffect, useState } from "react";
import { MapContainer, TileLayer, Marker, useMapEvents, useMap } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import L from "leaflet";

// Fix default marker icons broken by webpack
// @ts-expect-error – private field
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  iconUrl:       "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  shadowUrl:     "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
});

// Batangas City center
const DEFAULT_CENTER: [number, number] = [13.7565, 121.0583];

// Bias search results toward the Batangas City area (lng1,lat1,lng2,lat2)
const SEARCH_VIEWBOX = "120.90,13.90,121.20,13.60";

function ClickHandler({ onChange }: { onChange: (lat: number, lng: number) => void }) {
  useMapEvents({ click: (e) => onChange(e.latlng.lat, e.latlng.lng) });
  return null;
}

function FlyTo({ lat, lng }: { lat: number; lng: number }) {
  const map = useMap();
  useEffect(() => { map.setView([lat, lng], map.getZoom()); }, [lat, lng, map]);
  return null;
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

interface SearchResult {
  display_name: string;
  lat: string;
  lon: string;
}

interface Props {
  lat: number | null;
  lng: number | null;
  onChange: (lat: number, lng: number) => void;
}

export default function LocationPicker({ lat, lng, onChange }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchMsg, setSearchMsg] = useState<string | null>(null);

  const center: [number, number] = lat != null && lng != null ? [lat, lng] : DEFAULT_CENTER;

  // Close the expanded view with Escape
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setExpanded(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);

  async function runSearch() {
    const q = query.trim();
    if (!q) return;
    setSearching(true);
    setSearchMsg(null);
    setResults([]);
    try {
      const url =
        `https://nominatim.openstreetmap.org/search?format=json&limit=5&countrycodes=ph` +
        `&viewbox=${SEARCH_VIEWBOX}&q=${encodeURIComponent(q)}`;
      const res = await fetch(url, { headers: { "Accept-Language": "en" } });
      const data: SearchResult[] = await res.json();
      if (!data.length) setSearchMsg("No results — try a barangay, street, or landmark name.");
      setResults(data);
    } catch {
      setSearchMsg("Search failed — check your internet connection.");
    } finally {
      setSearching(false);
    }
  }

  function pickResult(r: SearchResult) {
    onChange(parseFloat(r.lat), parseFloat(r.lon));
    setResults([]);
    setQuery(r.display_name.split(",")[0]);
  }

  const wrapperStyle: React.CSSProperties = expanded
    ? {
        position: "fixed", inset: 20, zIndex: 12000,
        background: "white", borderRadius: 16, padding: 14,
        boxShadow: "0 12px 48px rgba(0,0,0,0.35)",
        display: "flex", flexDirection: "column",
      }
    : {};

  return (
    <>
      {expanded && (
        <div
          style={{ position: "fixed", inset: 0, zIndex: 11999, background: "rgba(15,23,42,0.45)" }}
          onClick={() => setExpanded(false)}
        />
      )}

      <div style={wrapperStyle}>
        {/* Search row */}
        <div style={{ position: "relative", marginBottom: 8 }}>
          <div style={{ display: "flex", gap: 6 }}>
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); runSearch(); } }}
              placeholder="Search a place, street, or barangay…"
              style={{
                flex: 1, fontSize: 12, padding: "7px 10px", borderRadius: 8,
                border: "1.5px solid #e2e8f0", outline: "none", fontFamily: "inherit",
              }}
            />
            <button
              type="button"
              onClick={runSearch}
              disabled={searching}
              style={{
                fontSize: 12, padding: "7px 12px", borderRadius: 8, border: "none",
                background: searching ? "#94a3b8" : "#0f6e56", color: "white",
                cursor: searching ? "wait" : "pointer", fontWeight: 600, whiteSpace: "nowrap",
              }}
            >
              {searching ? "…" : "Search"}
            </button>
            <button
              type="button"
              onClick={() => setExpanded(v => !v)}
              title={expanded ? "Collapse map" : "Expand map"}
              style={{
                fontSize: 12, padding: "7px 12px", borderRadius: 8,
                border: "1.5px solid #e2e8f0", background: "white", color: "#374151",
                cursor: "pointer", fontWeight: 600, whiteSpace: "nowrap",
              }}
            >
              {expanded ? "✕ Close" : "⛶ Expand"}
            </button>
          </div>

          {/* Results dropdown */}
          {(results.length > 0 || searchMsg) && (
            <div style={{
              position: "absolute", top: "100%", left: 0, right: 0, marginTop: 4,
              background: "white", border: "1px solid #e2e8f0", borderRadius: 10,
              boxShadow: "0 8px 24px rgba(0,0,0,0.14)", zIndex: 1200, overflow: "hidden",
            }}>
              {searchMsg && (
                <div style={{ padding: "9px 12px", fontSize: 12, color: "#94a3b8" }}>{searchMsg}</div>
              )}
              {results.map((r, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => pickResult(r)}
                  style={{
                    display: "block", width: "100%", textAlign: "left",
                    padding: "9px 12px", fontSize: 12, color: "#1a202c",
                    background: "white", border: "none", cursor: "pointer",
                    borderBottom: i < results.length - 1 ? "1px solid #f1f5f9" : "none",
                    fontFamily: "inherit",
                  }}
                  onMouseEnter={e => (e.currentTarget.style.background = "#f0fdf4")}
                  onMouseLeave={e => (e.currentTarget.style.background = "white")}
                >
                  {r.display_name}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Map — sized by this wrapper; MapContainer props are immutable
            after mount, so its own style must stay a constant 100%. */}
        <div style={{
          flex: expanded ? 1 : undefined,
          height: expanded ? "auto" : 220,
          minHeight: expanded ? 0 : 220,
          borderRadius: 10, overflow: "hidden", border: "1.5px solid #e2e8f0",
        }}>
          <MapContainer
            center={center}
            zoom={15}
            style={{ height: "100%", width: "100%", cursor: "crosshair" }}
            scrollWheelZoom={false}
          >
            <TileLayer
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
            />
            <ClickHandler onChange={onChange} />
            <ResizeFix expanded={expanded} />
            {lat != null && lng != null && (
              <>
                <Marker position={[lat, lng]} />
                <FlyTo lat={lat} lng={lng} />
              </>
            )}
          </MapContainer>
        </div>

        <div style={{ marginTop: 5, fontSize: 11, color: "#64748b" }}>
          {lat != null && lng != null
            ? <span style={{ fontFamily: "monospace" }}>{lat.toFixed(6)}, {lng.toFixed(6)}</span>
            : <span style={{ color: "#94a3b8" }}>Click the map to place a pin, or search above</span>
          }
          {expanded && <span style={{ marginLeft: 10, color: "#94a3b8" }}>Press Esc or ✕ to close</span>}
        </div>
      </div>
    </>
  );
}
