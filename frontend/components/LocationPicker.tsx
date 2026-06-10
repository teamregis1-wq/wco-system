"use client";

import { useEffect } from "react";
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

function ClickHandler({ onChange }: { onChange: (lat: number, lng: number) => void }) {
  useMapEvents({ click: (e) => onChange(e.latlng.lat, e.latlng.lng) });
  return null;
}

function FlyTo({ lat, lng }: { lat: number; lng: number }) {
  const map = useMap();
  useEffect(() => { map.setView([lat, lng], map.getZoom()); }, [lat, lng, map]);
  return null;
}

interface Props {
  lat: number | null;
  lng: number | null;
  onChange: (lat: number, lng: number) => void;
}

export default function LocationPicker({ lat, lng, onChange }: Props) {
  const center: [number, number] = lat != null && lng != null ? [lat, lng] : DEFAULT_CENTER;

  return (
    <div>
      <MapContainer
        center={center}
        zoom={15}
        style={{ height: 220, width: "100%", borderRadius: 10, cursor: "crosshair", border: "1.5px solid #e2e8f0" }}
        scrollWheelZoom={false}
      >
        <TileLayer
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        />
        <ClickHandler onChange={onChange} />
        {lat != null && lng != null && (
          <>
            <Marker position={[lat, lng]} />
            <FlyTo lat={lat} lng={lng} />
          </>
        )}
      </MapContainer>
      <div style={{ marginTop: 5, fontSize: 11, color: "#64748b" }}>
        {lat != null && lng != null
          ? <span style={{ fontFamily: "monospace" }}>📍 {lat.toFixed(6)}, {lng.toFixed(6)}</span>
          : <span style={{ color: "#94a3b8" }}>Click the map to place a pin</span>
        }
      </div>
    </div>
  );
}
