"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import dynamic from "next/dynamic";
import ProtectedRoute from "@/components/ProtectedRoute";
import { RoleGuard } from "@/components/ProtectedRoute";
import Navbar from "@/components/Navbar";
import PageShell, { card, primaryBtn, ghostBtn, input, label } from "@/components/PageShell";
import { getToken } from "@/lib/api";
import ForecastChart from "@/components/ForecastChart";
import type { ForecastPoint } from "@/lib/api";
import { toast, Toaster } from "@/components/Toast";
import {
  BarChart, Bar, LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip as RCTooltip,
  ResponsiveContainer, ReferenceLine,
} from "recharts";

const LocationPicker = dynamic(() => import("@/components/LocationPicker"), { ssr: false });

// ── CSV export helper ─────────────────────────────────────────────────────────

function downloadCSV(rows: Record<string, unknown>[], filename: string) {
  if (!rows.length) return;
  const headers = Object.keys(rows[0]);
  const escape = (v: unknown) => {
    const s = v == null ? "" : String(v);
    return s.includes(",") || s.includes('"') || s.includes("\n")
      ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [headers.join(","), ...rows.map(r => headers.map(h => escape(r[h])).join(","))].join("\n");
  const a = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(new Blob([csv], { type: "text/csv" })),
    download: filename,
  });
  a.click(); URL.revokeObjectURL(a.href);
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface QualityTest {
  id: number;
  establishment_id: number;
  sample_date: string;
  ffa_pct: number;
  viscosity_cp: number;
  density_gml: number;
  created_at: string;
}

interface WCORecord {
  id: number;
  establishment_id: number;
  week_date: string;
  week_end_date: string | null;
  quantity_liters: number;
  notes: string | null;
  created_at: string;
}

interface WCOCompleteness {
  weeks_with_data: number;
  expected_weeks: number;
  completeness_pct: number;
  first_record_date: string | null;
  last_record_date: string | null;
}
interface MonthlyTotal {
  year: number;
  month: number;
  total_liters: number;
  record_count: number;
}

interface Establishment {
  id: number;
  wco_code: string;
  name: string;
  type: string;
  address: string | null;
  barangay: string | null;
  latitude: number;
  longitude: number;
  business_hours: string | null;
  seating_capacity: number | null;
  contact_info: string | null;
  consent_given: boolean;
  is_active: boolean;
  created_at: string;
}

type FormData = {
  wco_code: string; name: string; type: string;
  latitude: string; longitude: string;
  barangay: string;
};

const EMPTY_FORM: FormData = {
  wco_code: "", name: "", type: "restaurant",
  latitude: "", longitude: "", barangay: "",
};

// ── Tokens ────────────────────────────────────────────────────────────────────

const TYPE_STYLE: Record<string, { bg: string; color: string; label: string }> = {
  restaurant:         { bg: "#ecfdf5", color: "#065f46", label: "Restaurant" },
  fast_food:          { bg: "#fff7ed", color: "#9a3412", label: "Fast Food" },
  food_manufacturer:  { bg: "#eff6ff", color: "#1e40af", label: "Food Mfr." },
};

const BARANGAYS = [
  "Poblacion", "Kumintang Ibaba", "Kumintang Ilaya", "Sta. Clara",
  "Pallocan West", "Pallocan East", "Libjo", "Bolbok", "Cuta",
  "Calicanto", "Alangilan", "Gulod Labac", "Gulod Itaas", "Bagong Sikat",
];

// ── API ───────────────────────────────────────────────────────────────────────

const BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000/api/v1";

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
    const msg = await res.text().catch(() => res.statusText);
    throw new Error(msg);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

// ── Date-range helpers ────────────────────────────────────────────────────────

function addSixDays(startStr: string): string {
  const d = new Date(startStr + "T00:00:00");
  d.setDate(d.getDate() + 6);
  return d.toISOString().split("T")[0];
}

function weekRangeLabel(startStr: string, endStr?: string | null): string {
  const start = new Date(startStr + "T00:00:00");
  const end   = endStr
    ? new Date(endStr + "T00:00:00")
    : (() => { const d = new Date(startStr + "T00:00:00"); d.setDate(d.getDate() + 6); return d; })();
  const fmt = (d: Date) =>
    d.toLocaleDateString("en-PH", { month: "short", day: "numeric" });
  return `${fmt(start)} – ${fmt(end)}, ${end.getFullYear()}`;
}

// ── Sub-components ────────────────────────────────────────────────────────────

function TypeBadge({ type }: { type: string }) {
  const s = TYPE_STYLE[type] ?? { bg: "#f1f5f9", color: "#475569", label: type };
  return (
    <span style={{ fontSize: 11, fontWeight: 700, padding: "3px 9px", borderRadius: 99, background: s.bg, color: s.color, whiteSpace: "nowrap" }}>
      {s.label}
    </span>
  );
}

function StatusBadge({ active }: { active: boolean }) {
  return (
    <span style={{
      fontSize: 11, fontWeight: 700, padding: "3px 9px", borderRadius: 99,
      background: active ? "#ecfdf5" : "#f1f5f9",
      color: active ? "#065f46" : "#94a3b8",
    }}>
      {active ? "Active" : "Inactive"}
    </span>
  );
}

function F({ children }: { children: React.ReactNode }) {
  return <div style={{ marginBottom: 12 }}>{children}</div>;
}

// ── Modal ─────────────────────────────────────────────────────────────────────

function EstablishmentModal({
  initial, onClose, onSaved,
}: {
  initial?: Establishment | null;
  onClose: () => void;
  onSaved: (e: Establishment) => void;
}) {
  const editing = !!initial;
  const [form, setForm] = useState<FormData>(
    initial
      ? {
          wco_code: initial.wco_code, name: initial.name, type: initial.type,
          latitude: String(initial.latitude), longitude: String(initial.longitude),
          barangay: initial.barangay ?? "",
        }
      : EMPTY_FORM,
  );
  const [busy,       setBusy]       = useState(false);
  const [error,      setError]      = useState<string | null>(null);
  const [detecting,  setDetecting]  = useState(false);

  function set(k: keyof FormData, v: string | boolean) {
    setForm(prev => ({ ...prev, [k]: v }));
  }

  async function detectBarangay(lat: number, lng: number) {
    setDetecting(true);
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}`,
        { headers: { "Accept-Language": "en" } }
      );
      if (!res.ok) return;
      const data = await res.json();
      const addr = data.address ?? {};
      const candidate: string =
        addr.suburb ?? addr.neighbourhood ?? addr.village ?? addr.quarter ?? "";
      const norm = (s: string) => s.toLowerCase().trim();
      const match = BARANGAYS.find(b =>
        norm(b) === norm(candidate) ||
        norm(candidate).includes(norm(b)) ||
        norm(b).includes(norm(candidate))
      );
      if (match) set("barangay", match);
    } catch {
      // silent — user can pick manually
    } finally {
      setDetecting(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!form.latitude || !form.longitude) {
      setError("Please pin the location on the map.");
      return;
    }
    setBusy(true);
    try {
      const body: Record<string, unknown> = {
        name: form.name, type: form.type,
        latitude: parseFloat(form.latitude), longitude: parseFloat(form.longitude),
        consent_given: true,
      };
      if (!editing) body.wco_code = form.wco_code;
      if (form.barangay) body.barangay = form.barangay;

      const saved = editing
        ? await apiFetch<Establishment>(`/establishments/${initial!.id}`, { method: "PATCH", body: JSON.stringify(body) })
        : await apiFetch<Establishment>("/establishments", { method: "POST", body: JSON.stringify(body) });

      toast(editing ? "Establishment updated." : "Establishment added.");
      onSaved(saved);
      onClose();
    } catch (err) {
      setError(String(err).replace(/^(Type)?Error:\s*/, ""));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={MO.overlay} onClick={onClose}>
      <div style={MO.modal} onClick={e => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
          <h2 style={{ fontSize: 18, fontWeight: 800, color: "#111827", margin: 0 }}>
            {editing ? "Edit establishment" : "Add establishment"}
          </h2>
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 18, cursor: "pointer", color: "#94a3b8", padding: "2px 6px" }}>✕</button>
        </div>

        <form onSubmit={submit}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 14px" }}>
            {!editing && (
              <F>
                <label style={label}>WCO Code *</label>
                <input style={input} value={form.wco_code} onChange={e => set("wco_code", e.target.value)} required placeholder="e.g. FF001" />
              </F>
            )}
            <F>
              <label style={label}>Establishment name *</label>
              <input style={{ ...input, gridColumn: "1/-1" }} value={form.name} onChange={e => set("name", e.target.value)} required placeholder="e.g. Jollibee Batangas City" />
            </F>
            <F>
              <label style={label}>Type *</label>
              <select style={input} value={form.type} onChange={e => set("type", e.target.value)} required>
                <option value="restaurant">Restaurant</option>
                <option value="fast_food">Fast Food</option>
                <option value="food_manufacturer">Food Manufacturer</option>
              </select>
            </F>
            <F>
              <label style={{ ...label, display: "flex", alignItems: "center", gap: 6 }}>
                Barangay
                {detecting && (
                  <span style={{ fontSize: 10, color: "#0f6e56", fontWeight: 500 }}>detecting…</span>
                )}
              </label>
              <select
                style={{ ...input, opacity: detecting ? 0.6 : 1 }}
                value={form.barangay}
                onChange={e => set("barangay", e.target.value)}
                disabled={detecting}
              >
                <option value="">— select or pin map —</option>
                {BARANGAYS.map(b => <option key={b} value={b}>{b}</option>)}
              </select>
            </F>
          </div>

          {/* Map pin — full width */}
          <F>
            <label style={label}>Location * — click map to pin</label>
            <LocationPicker
              lat={form.latitude ? parseFloat(form.latitude) : null}
              lng={form.longitude ? parseFloat(form.longitude) : null}
              onChange={(lat, lng) => {
                set("latitude", String(lat.toFixed(6)));
                set("longitude", String(lng.toFixed(6)));
                detectBarangay(lat, lng);
              }}
            />
          </F>

          {error && (
            <div style={{ padding: "9px 12px", background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 8, fontSize: 13, color: "#dc2626", marginBottom: 12 }}>
              {error}
            </div>
          )}

          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button type="button" onClick={onClose} style={ghostBtn}>Cancel</button>
            <button type="submit" disabled={busy} style={{ ...primaryBtn, opacity: busy ? 0.7 : 1 }}>
              {busy ? "Saving…" : editing ? "Save changes" : "Add establishment"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── WCO Records modal ─────────────────────────────────────────────────────────

function WCORecordsModal({
  establishment,
  onClose,
  onRecordChanged,
}: {
  establishment: Establishment;
  onClose: () => void;
  onRecordChanged?: () => void;
}) {
  const [records,      setRecords]      = useState<WCORecord[]>([]);
  const [loading,      setLoading]      = useState(true);
  const [error,        setError]        = useState<string | null>(null);
  const [deleteConf,   setDeleteConf]   = useState<number | null>(null);
  const [editingId,    setEditingId]    = useState<number | null>(null);
  const [editQty,      setEditQty]      = useState("");
  const [editNotes,    setEditNotes]    = useState("");
  const [editBusy,     setEditBusy]     = useState(false);
  const [bulkStatus,   setBulkStatus]   = useState<string | null>(null);
  const [bulkImporting,setBulkImporting]= useState(false);
  const [completeness, setCompleteness] = useState<WCOCompleteness | null>(null);
  const [monthlyTotals,setMonthlyTotals]= useState<MonthlyTotal[]>([]);
  const wcoFileRef = useRef<HTMLInputElement>(null);

  // Add-record form state
  const [weekDate,    setWeekDate]    = useState("");
  const [weekEndDate, setWeekEndDate] = useState("");
  const [quantity,    setQuantity]    = useState("");
  const [notes,       setNotes]       = useState("");
  const [addBusy,     setAddBusy]     = useState(false);
  const [addError,    setAddError]    = useState<string | null>(null);

  const loadRecords = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [data, comp, monthly] = await Promise.all([
        apiFetch<WCORecord[]>(`/wco/records?establishment_id=${establishment.id}`),
        apiFetch<WCOCompleteness>(`/wco/completeness/${establishment.id}`).catch(() => null),
        apiFetch<MonthlyTotal[]>(`/wco/monthly/${establishment.id}`).catch(() => [] as MonthlyTotal[]),
      ]);
      setRecords(data);
      setCompleteness(comp);
      setMonthlyTotals(monthly as MonthlyTotal[]);
    } catch (e) { setError(String(e)); }
    finally { setLoading(false); }
  }, [establishment.id]);

  useEffect(() => { loadRecords(); }, [loadRecords]);

  async function addRecord(e: React.FormEvent) {
    e.preventDefault();
    setAddError(null);
    setAddBusy(true);
    try {
      const rec = await apiFetch<WCORecord>("/wco/records", {
        method: "POST",
        body: JSON.stringify({
          establishment_id: establishment.id,
          week_date: weekDate,
          week_end_date: weekEndDate || null,
          quantity_liters: parseFloat(quantity),
          notes: notes.trim() || null,
        }),
      });
      setRecords(prev => [rec, ...prev]);
      setWeekDate(""); setWeekEndDate(""); setQuantity(""); setNotes("");
      toast("WCO record added.");
      onRecordChanged?.();
    } catch (err) {
      setAddError(String(err).replace(/^(Type)?Error:\s*/, ""));
    } finally {
      setAddBusy(false);
    }
  }

  async function deleteRecord(id: number) {
    try {
      await apiFetch(`/wco/records/${id}`, { method: "DELETE" });
      setRecords(prev => prev.filter(r => r.id !== id));
      setDeleteConf(null);
      toast("Record deleted.", "info");
      onRecordChanged?.();
    } catch (err) { toast(String(err).replace(/^(Type)?Error:\s*/, ""), "error"); }
  }

  async function saveEdit(id: number) {
    setEditBusy(true);
    try {
      const updated = await apiFetch<WCORecord>(`/wco/records/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ quantity_liters: parseFloat(editQty), notes: editNotes.trim() || null }),
      });
      setRecords(prev => prev.map(r => r.id === id ? updated : r));
      setEditingId(null);
      toast("Record updated.");
    } catch (err) { toast(String(err).replace(/^(Type)?Error:\s*/, ""), "error"); }
    finally { setEditBusy(false); }
  }

  async function handleWCOCSV(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    setBulkImporting(true); setBulkStatus(null);
    const text = await file.text();
    const lines = text.trim().split(/\r?\n/);
    if (lines.length < 2) { setBulkImporting(false); setBulkStatus("CSV empty or missing header."); return; }
    const headers = lines[0].split(",").map(h => h.trim().toLowerCase().replace(/^"|"$/g, ""));
    const rows = lines.slice(1).filter(l => l.trim()).map(line => {
      const vals = line.split(",").map(v => v.trim().replace(/^"|"$/g, ""));
      const row: Record<string, string> = {};
      headers.forEach((h, i) => { row[h] = vals[i] ?? ""; });
      return row;
    });
    const find = (row: Record<string, string>, ...keys: string[]) => {
      for (const k of keys) { const v = row[k]; if (v != null) return v; } return "";
    };
    const payload = rows.map(row => ({
      establishment_id: establishment.id,
      week_date: find(row, "week_date", "date", "week"),
      week_end_date: find(row, "week_end_date", "end_date") || null,
      quantity_liters: parseFloat(find(row, "quantity_liters", "quantity", "liters")),
      notes: find(row, "notes") || null,
    })).filter(r => r.week_date && !isNaN(r.quantity_liters));
    if (!payload.length) { setBulkImporting(false); setBulkStatus("No valid rows. Headers: week_date,quantity_liters,notes"); return; }
    try {
      const res = await apiFetch<{ imported: number; skipped: number }>("/wco/records/bulk", {
        method: "POST", body: JSON.stringify(payload),
      });
      setBulkStatus(`${res.imported} imported, ${res.skipped} skipped.`);
      toast(`${res.imported} WCO record${res.imported !== 1 ? "s" : ""} imported.`);
      await loadRecords();
      onRecordChanged?.();
    } catch (err) { setBulkStatus(String(err).replace(/^(Type)?Error:\s*/, "")); toast(String(err).replace(/^(Type)?Error:\s*/, ""), "error"); }
    finally { setBulkImporting(false); }
  }

  const totalLiters = records.reduce((sum, r) => sum + r.quantity_liters, 0);

  return (
    <div style={MO.overlay} onClick={onClose}>
      <div style={{ ...MO.modal, maxWidth: 640 }} onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20 }}>
          <div>
            <h2 style={{ fontSize: 17, fontWeight: 800, color: "#111827", margin: "0 0 2px" }}>WCO Records</h2>
            <div style={{ fontSize: 12, color: "#64748b" }}>{establishment.name} · {establishment.wco_code}</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <RoleGuard action="edit">
              <input ref={wcoFileRef} type="file" accept=".csv" style={{ display: "none" }} onChange={handleWCOCSV} />
              <button
                onClick={() => wcoFileRef.current?.click()}
                disabled={bulkImporting}
                style={{ ...ghostBtn, fontSize: 11, padding: "5px 12px", color: "#0369a1", borderColor: "#7dd3fc", opacity: bulkImporting ? 0.45 : 1 }}
              >
                {bulkImporting ? "Importing…" : "Import CSV"}
              </button>
            </RoleGuard>
            <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 18, cursor: "pointer", color: "#94a3b8", padding: "2px 6px" }}>✕</button>
          </div>
        </div>
        {bulkStatus && (
          <div style={{ marginBottom: 12, padding: "7px 12px", background: bulkStatus.includes("imported") ? "#f0fdf4" : "#fef2f2", border: `1px solid ${bulkStatus.includes("imported") ? "#bbf7d0" : "#fca5a5"}`, borderRadius: 8, fontSize: 12, color: bulkStatus.includes("imported") ? "#166534" : "#dc2626" }}>
            {bulkStatus}
          </div>
        )}

        {/* Completeness badge */}
        {completeness && (
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, padding: "8px 14px", background: "#f8fafc", borderRadius: 10, border: "1px solid #e2e8f0" }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 3 }}>Data completeness</div>
              <div style={{ height: 6, background: "#e2e8f0", borderRadius: 99, overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${completeness.completeness_pct}%`, background: completeness.completeness_pct >= 75 ? "#0f6e56" : completeness.completeness_pct >= 50 ? "#d97706" : "#dc2626", borderRadius: 99, transition: "width 0.4s ease" }} />
              </div>
            </div>
            <div style={{ fontSize: 18, fontWeight: 900, color: completeness.completeness_pct >= 75 ? "#0f6e56" : completeness.completeness_pct >= 50 ? "#d97706" : "#dc2626", fontVariantNumeric: "tabular-nums", minWidth: 48, textAlign: "right" }}>
              {completeness.completeness_pct.toFixed(0)}%
            </div>
            <div style={{ fontSize: 10, color: "#94a3b8" }}>
              {completeness.weeks_with_data}/{completeness.expected_weeks} wks
            </div>
          </div>
        )}

        {/* Summary strip */}
        <div style={{ display: "flex", gap: 12, marginBottom: 20 }}>
          {[
            { label: "Records",     value: records.length },
            { label: "Total (L)",   value: totalLiters.toLocaleString(undefined, { maximumFractionDigits: 1 }) },
            { label: "Avg / week",  value: records.length ? (totalLiters / records.length).toFixed(1) : "—" },
          ].map(s => (
            <div key={s.label} style={{ flex: 1, background: "#f8fafc", borderRadius: 10, padding: "10px 14px", border: "1px solid #e2e8f0" }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 3 }}>{s.label}</div>
              <div style={{ fontSize: 20, fontWeight: 900, color: "#0f6e56", fontVariantNumeric: "tabular-nums" }}>{s.value}</div>
            </div>
          ))}
        </div>

        {/* Monthly totals chart */}
        {monthlyTotals.length > 1 && (
          <div style={{ marginBottom: 18 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>Monthly WCO Totals</div>
            <ResponsiveContainer width="100%" height={110}>
              <BarChart data={monthlyTotals.map(m => ({
                label: new Date(m.year, m.month - 1).toLocaleString("default", { month: "short", year: "2-digit" }),
                total: m.total_liters,
              }))} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis dataKey="label" tick={{ fontSize: 9, fill: "#94a3b8" }} tickLine={false} axisLine={false} />
                <YAxis tick={{ fontSize: 9, fill: "#94a3b8" }} tickLine={false} axisLine={false} tickFormatter={v => `${v}L`} width={36} />
                <RCTooltip formatter={(v: number) => [`${v.toLocaleString(undefined, { maximumFractionDigits: 1 })} L`, "Total WCO"]} contentStyle={{ fontSize: 11, borderRadius: 8 }} />
                <Bar dataKey="total" fill="#0f6e56" radius={[4, 4, 0, 0]} maxBarSize={28} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* Add record form (researcher+) */}
        <RoleGuard action="edit">
          <form onSubmit={addRecord} style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 12, padding: "14px 16px", marginBottom: 18 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#166534", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 10 }}>Add record</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <div>
                <label style={{ ...label, color: "#166534" }}>Start date *</label>
                <input
                  style={input} type="date" value={weekDate} required
                  onChange={e => {
                    setWeekDate(e.target.value);
                    // Auto-fill end date when start is picked
                    if (e.target.value) setWeekEndDate(addSixDays(e.target.value));
                  }}
                />
              </div>
              <div>
                <label style={{ ...label, color: "#166534" }}>End date *</label>
                <input
                  style={input} type="date" value={weekEndDate} required
                  min={weekDate || undefined}
                  onChange={e => setWeekEndDate(e.target.value)}
                />
                {weekDate && weekEndDate && (
                  <div style={{ fontSize: 10, color: "#166534", marginTop: 2 }}>
                    {weekRangeLabel(weekDate, weekEndDate)}
                  </div>
                )}
              </div>
              <div>
                <label style={{ ...label, color: "#166534" }}>Liters *</label>
                <input style={input} type="number" step="0.1" min="0" value={quantity}
                  onChange={e => setQuantity(e.target.value)} required placeholder="e.g. 25.5" />
              </div>
              <div>
                <label style={{ ...label, color: "#166534" }}>Notes</label>
                <input style={input} value={notes} onChange={e => setNotes(e.target.value)} placeholder="Optional" />
              </div>
            </div>
            {addError && (
              <div style={{ marginTop: 8, padding: "7px 10px", background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 8, fontSize: 12, color: "#dc2626" }}>
                {addError}
              </div>
            )}
            <div style={{ marginTop: 10, display: "flex", justifyContent: "flex-end" }}>
              <button type="submit" disabled={addBusy} style={{ ...primaryBtn, padding: "7px 18px", fontSize: 12, opacity: addBusy ? 0.7 : 1 }}>
                {addBusy ? "Saving…" : "+ Add record"}
              </button>
            </div>
          </form>
        </RoleGuard>

        {/* Records list */}
        {error && (
          <div style={{ padding: "9px 12px", background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 8, fontSize: 13, color: "#dc2626", marginBottom: 12 }}>
            {error}
          </div>
        )}
        {loading ? (
          <div style={{ textAlign: "center", padding: "32px 0", color: "#94a3b8", fontSize: 13 }}>Loading…</div>
        ) : records.length === 0 ? (
          <div style={{ textAlign: "center", padding: "32px 0", color: "#94a3b8", fontSize: 13 }}>No records yet.</div>
        ) : (
          <div style={{ overflowY: "auto", maxHeight: 280 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ background: "#f8fafc" }}>
                  {["Week", "Liters", "Notes", ""].map(h => (
                    <th key={h} style={{ padding: "8px 12px", textAlign: "left", fontSize: 10, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.05em", borderBottom: "1px solid #e2e8f0", whiteSpace: "nowrap" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {records.map((r, i) => (
                  <tr key={r.id} style={{ background: i % 2 === 0 ? "white" : "#fafafa" }}>
                    <td style={{ padding: "9px 12px", borderBottom: "1px solid #f1f5f9", fontWeight: 600, color: "#1a202c", whiteSpace: "nowrap" }}>
                      {weekRangeLabel(r.week_date, r.week_end_date)}
                    </td>
                    {editingId === r.id ? (
                      <>
                        <td style={{ padding: "6px 8px", borderBottom: "1px solid #f1f5f9" }}>
                          <input
                            type="number" step="0.1" min="0"
                            value={editQty}
                            onChange={e => setEditQty(e.target.value)}
                            style={{ ...input, padding: "4px 8px", fontSize: 12, width: 80 }}
                            autoFocus
                          />
                        </td>
                        <td style={{ padding: "6px 8px", borderBottom: "1px solid #f1f5f9" }}>
                          <input
                            value={editNotes}
                            onChange={e => setEditNotes(e.target.value)}
                            placeholder="Notes"
                            style={{ ...input, padding: "4px 8px", fontSize: 12, width: 120 }}
                          />
                        </td>
                        <td style={{ padding: "6px 8px", borderBottom: "1px solid #f1f5f9", whiteSpace: "nowrap" }}>
                          <div style={{ display: "flex", gap: 4 }}>
                            <button onClick={() => saveEdit(r.id)} disabled={editBusy} style={{ ...ghostBtn, fontSize: 11, padding: "3px 8px", color: "#166534", borderColor: "#86efac", opacity: editBusy ? 0.7 : 1 }}>
                              {editBusy ? "…" : "Save"}
                            </button>
                            <button onClick={() => setEditingId(null)} style={{ ...ghostBtn, fontSize: 11, padding: "3px 8px" }}>Cancel</button>
                          </div>
                        </td>
                      </>
                    ) : (
                      <>
                        <td style={{ padding: "9px 12px", borderBottom: "1px solid #f1f5f9", color: "#0f6e56", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
                          {r.quantity_liters.toLocaleString(undefined, { maximumFractionDigits: 1 })} L
                        </td>
                        <td style={{ padding: "9px 12px", borderBottom: "1px solid #f1f5f9", color: "#64748b", fontSize: 12 }}>
                          {r.notes ?? "—"}
                        </td>
                        <td style={{ padding: "9px 12px", borderBottom: "1px solid #f1f5f9", whiteSpace: "nowrap" }}>
                          <RoleGuard action="edit">
                            <div style={{ display: "flex", gap: 4 }}>
                              <button
                                onClick={() => { setEditingId(r.id); setEditQty(String(r.quantity_liters)); setEditNotes(r.notes ?? ""); }}
                                style={{ ...ghostBtn, fontSize: 11, padding: "3px 8px", color: "#0369a1", borderColor: "#7dd3fc" }}
                              >Edit</button>
                              {deleteConf === r.id ? (
                                <>
                                  <button onClick={() => deleteRecord(r.id)} style={{ ...ghostBtn, fontSize: 11, padding: "3px 8px", color: "#dc2626", borderColor: "#fca5a5" }}>Confirm</button>
                                  <button onClick={() => setDeleteConf(null)} style={{ ...ghostBtn, fontSize: 11, padding: "3px 8px" }}>Cancel</button>
                                </>
                              ) : (
                                <button onClick={() => setDeleteConf(r.id)} style={{ ...ghostBtn, fontSize: 11, padding: "3px 8px", color: "#dc2626", borderColor: "#fca5a5" }}>Delete</button>
                              )}
                            </div>
                          </RoleGuard>
                        </td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Quality Tests modal ───────────────────────────────────────────────────────

function QualityTestsModal({ establishment, onClose }: { establishment: Establishment; onClose: () => void }) {
  const [tests,      setTests]      = useState<QualityTest[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [deleteConf, setDeleteConf] = useState<number | null>(null);
  const [sampleDate, setSampleDate] = useState("");
  const [ffa,        setFfa]        = useState("");
  const [visc,       setVisc]       = useState("");
  const [dens,       setDens]       = useState("");
  const [addBusy,    setAddBusy]    = useState(false);
  const [addError,   setAddError]   = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch<QualityTest[]>(`/quality-tests?establishment_id=${establishment.id}`);
      setTests(data);
    } catch { /* silent */ }
    finally { setLoading(false); }
  }, [establishment.id]);

  useEffect(() => { load(); }, [load]);

  async function addTest(e: React.FormEvent) {
    e.preventDefault();
    setAddError(null); setAddBusy(true);
    try {
      const t = await apiFetch<QualityTest>("/quality-tests", {
        method: "POST",
        body: JSON.stringify({
          establishment_id: establishment.id,
          sample_date: sampleDate,
          ffa_pct: parseFloat(ffa),
          viscosity_cp: parseFloat(visc),
          density_gml: parseFloat(dens),
        }),
      });
      setTests(prev => [t, ...prev]);
      setSampleDate(""); setFfa(""); setVisc(""); setDens("");
      toast("Quality test added.");
    } catch (err) { setAddError(String(err).replace(/^(Type)?Error:\s*/, "")); }
    finally { setAddBusy(false); }
  }

  async function del(id: number) {
    try {
      await apiFetch(`/quality-tests/${id}`, { method: "DELETE" });
      setTests(prev => prev.filter(t => t.id !== id)); setDeleteConf(null);
      toast("Test deleted.", "info");
    } catch (err) { toast(String(err).replace(/^(Type)?Error:\s*/, ""), "error"); }
  }

  function ffaGrade(v: number) {
    if (v < 3)  return { label: "Good",       color: "#065f46", bg: "#ecfdf5" };
    if (v < 5)  return { label: "Acceptable", color: "#92400e", bg: "#fef3c7" };
    return             { label: "Poor",        color: "#dc2626", bg: "#fef2f2" };
  }

  return (
    <div style={MO.overlay} onClick={onClose}>
      <div style={{ ...MO.modal, maxWidth: 660 }} onClick={e => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20 }}>
          <div>
            <h2 style={{ fontSize: 17, fontWeight: 800, color: "#111827", margin: "0 0 2px" }}>Quality Tests</h2>
            <div style={{ fontSize: 12, color: "#64748b" }}>{establishment.name} · {establishment.wco_code}</div>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 18, cursor: "pointer", color: "#94a3b8" }}>✕</button>
        </div>

        <RoleGuard action="edit">
          <form onSubmit={addTest} style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 12, padding: "14px 16px", marginBottom: 18 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#166534", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 10 }}>Add sample</div>
            <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr 1fr 1fr", gap: 8 }}>
              <div>
                <label style={{ ...label, color: "#166534" }}>Sample date *</label>
                <input style={input} type="date" value={sampleDate} onChange={e => setSampleDate(e.target.value)} required />
              </div>
              <div>
                <label style={{ ...label, color: "#166534" }}>FFA % *</label>
                <input style={input} type="number" step="0.01" min="0" value={ffa} onChange={e => setFfa(e.target.value)} required placeholder="e.g. 2.5" />
              </div>
              <div>
                <label style={{ ...label, color: "#166534" }}>Viscosity (cP) *</label>
                <input style={input} type="number" step="0.1" min="0" value={visc} onChange={e => setVisc(e.target.value)} required placeholder="e.g. 45.0" />
              </div>
              <div>
                <label style={{ ...label, color: "#166534" }}>Density (g/mL) *</label>
                <input style={input} type="number" step="0.001" min="0" value={dens} onChange={e => setDens(e.target.value)} required placeholder="e.g. 0.915" />
              </div>
            </div>
            {addError && <div style={{ marginTop: 8, padding: "7px 10px", background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 8, fontSize: 12, color: "#dc2626" }}>{addError}</div>}
            <div style={{ marginTop: 10, display: "flex", justifyContent: "flex-end" }}>
              <button type="submit" disabled={addBusy} style={{ ...primaryBtn, padding: "7px 18px", fontSize: 12, opacity: addBusy ? 0.7 : 1 }}>
                {addBusy ? "Saving…" : "+ Add sample"}
              </button>
            </div>
          </form>
        </RoleGuard>

        {/* FFA trend chart */}
        {!loading && tests.length > 1 && (() => {
          const sorted = [...tests].sort((a, b) => a.sample_date.localeCompare(b.sample_date));
          const chartData = sorted.map(t => ({
            date: new Date(t.sample_date).toLocaleDateString("en-PH", { month: "short", day: "numeric" }),
            ffa: t.ffa_pct,
          }));
          return (
            <div style={{ marginBottom: 18 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>FFA % Trend</div>
              <ResponsiveContainer width="100%" height={110}>
                <LineChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="date" tick={{ fontSize: 9, fill: "#94a3b8" }} tickLine={false} axisLine={false} />
                  <YAxis tick={{ fontSize: 9, fill: "#94a3b8" }} tickLine={false} axisLine={false} tickFormatter={v => `${v}%`} width={32} domain={[0, "auto"]} />
                  <RCTooltip formatter={(v: number) => [`${v.toFixed(2)}%`, "FFA"]} contentStyle={{ fontSize: 11, borderRadius: 8 }} />
                  <ReferenceLine y={3} stroke="#d97706" strokeDasharray="4 3" label={{ value: "Good", position: "right", fontSize: 9, fill: "#d97706" }} />
                  <ReferenceLine y={5} stroke="#dc2626" strokeDasharray="4 3" label={{ value: "Poor", position: "right", fontSize: 9, fill: "#dc2626" }} />
                  <Line type="monotone" dataKey="ffa" stroke="#7c3aed" strokeWidth={2} dot={{ r: 3, fill: "#7c3aed" }} activeDot={{ r: 5 }} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          );
        })()}

        {loading ? (
          <div style={{ textAlign: "center", padding: "32px 0", color: "#94a3b8", fontSize: 13 }}>Loading…</div>
        ) : tests.length === 0 ? (
          <div style={{ textAlign: "center", padding: "32px 0", color: "#94a3b8", fontSize: 13 }}>No quality tests recorded yet.</div>
        ) : (
          <div style={{ overflowY: "auto", maxHeight: 300 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ background: "#f8fafc" }}>
                  {["Sample date", "FFA %", "Viscosity (cP)", "Density (g/mL)", "Grade", ""].map(h => (
                    <th key={h} style={{ padding: "8px 12px", textAlign: "left", fontSize: 10, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.05em", borderBottom: "1px solid #e2e8f0" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {tests.map((t, i) => {
                  const grade = ffaGrade(t.ffa_pct);
                  return (
                    <tr key={t.id} style={{ background: i % 2 === 0 ? "white" : "#fafafa" }}>
                      <td style={{ padding: "9px 12px", fontWeight: 600, color: "#1a202c" }}>
                        {new Date(t.sample_date).toLocaleDateString("en-PH", { year: "numeric", month: "short", day: "numeric" })}
                      </td>
                      <td style={{ padding: "9px 12px", fontVariantNumeric: "tabular-nums" }}>{t.ffa_pct.toFixed(2)}</td>
                      <td style={{ padding: "9px 12px", fontVariantNumeric: "tabular-nums" }}>{t.viscosity_cp.toFixed(1)}</td>
                      <td style={{ padding: "9px 12px", fontVariantNumeric: "tabular-nums" }}>{t.density_gml.toFixed(3)}</td>
                      <td style={{ padding: "9px 12px" }}>
                        <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 99, background: grade.bg, color: grade.color }}>{grade.label}</span>
                      </td>
                      <td style={{ padding: "9px 12px" }}>
                        <RoleGuard action="edit">
                          {deleteConf === t.id ? (
                            <div style={{ display: "flex", gap: 4 }}>
                              <button onClick={() => del(t.id)} style={{ ...ghostBtn, fontSize: 11, padding: "3px 8px", color: "#dc2626", borderColor: "#fca5a5" }}>Confirm</button>
                              <button onClick={() => setDeleteConf(null)} style={{ ...ghostBtn, fontSize: 11, padding: "3px 8px" }}>Cancel</button>
                            </div>
                          ) : (
                            <button onClick={() => setDeleteConf(t.id)} style={{ ...ghostBtn, fontSize: 11, padding: "3px 8px", color: "#dc2626", borderColor: "#fca5a5" }}>Delete</button>
                          )}
                        </RoleGuard>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Forecast modal ────────────────────────────────────────────────────────────

function ForecastModal({ establishment, onClose }: { establishment: Establishment; onClose: () => void }) {
  const [points, setPoints] = useState<ForecastPoint[] | null>(null);
  const [historical, setHistorical] = useState<WCORecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      apiFetch<{ points: ForecastPoint[]; establishment_id: number; model_version: string }>(
        `/forecast/${establishment.id}?horizon_weeks=13`
      ),
      apiFetch<WCORecord[]>(`/wco/records?establishment_id=${establishment.id}`),
    ])
      .then(([fc, recs]) => { setPoints(fc.points); setHistorical(recs); })
      .catch(e => setError(String(e).replace(/^(Type)?Error:\s*/, "")))
      .finally(() => setLoading(false));
  }, [establishment.id]);

  return (
    <div style={MO.overlay} onClick={onClose}>
      <div style={{ ...MO.modal, maxWidth: 740 }} onClick={e => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20 }}>
          <div>
            <h2 style={{ fontSize: 17, fontWeight: 800, color: "#111827", margin: "0 0 2px" }}>3-Month LSTM Forecast</h2>
            <div style={{ fontSize: 12, color: "#64748b" }}>{establishment.name} · {establishment.wco_code}</div>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 18, cursor: "pointer", color: "#94a3b8" }}>✕</button>
        </div>
        {loading ? (
          <div style={{ textAlign: "center", padding: "48px 0", color: "#94a3b8", fontSize: 13 }}>Loading forecast…</div>
        ) : error ? (
          <div style={{ padding: "12px 16px", background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 10, fontSize: 13, color: "#dc2626" }}>
            {error.includes("503") || error.includes("No trained")
              ? "No trained model yet — go to Admin → Forecasting and click Retrain LSTM first."
              : error}
          </div>
        ) : points ? (
          <ForecastChart points={points} historical={historical} />
        ) : null}
      </div>
    </div>
  );
}

// ── Establishment detail modal ────────────────────────────────────────────────

function printForecastChart(name: string, wcoCode: string) {
  const el = document.getElementById("detail-forecast-chart");
  if (!el) return;
  const win = window.open("", "_blank", "width=1000,height=700");
  if (!win) return;
  win.document.write(`<!DOCTYPE html><html><head><title>Forecast – ${name}</title>
<style>*{box-sizing:border-box}body{margin:24px;font-family:system-ui,sans-serif;background:white}svg{overflow:visible}.recharts-wrapper{width:100%!important}@media print{@page{margin:1in;size:A4 portrait}body{margin:0}*{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important}svg{max-width:100%!important;height:auto!important}}</style>
</head><body>
<h2 style="font-size:16px;font-weight:900;color:#111;margin:0 0 4px">${name} – 3-Month LSTM Forecast</h2>
<p style="font-size:12px;color:#64748b;margin:0 0 16px">${wcoCode} · WCO Predictive Mapping System</p>
${el.outerHTML}
</body></html>`);
  win.document.close();
  setTimeout(() => { win.focus(); win.print(); }, 400);
}

function EstablishmentDetailModal({
  establishment: e,
  onClose,
  onEdit,
  onViewWCO,
  onViewTests,
  onToggleActive,
  onDelete,
}: {
  establishment: Establishment;
  onClose: () => void;
  onEdit: (e: Establishment) => void;
  onViewWCO: (e: Establishment) => void;
  onViewTests: (e: Establishment) => void;
  onToggleActive: (e: Establishment) => void;
  onDelete: (id: number) => void;
}) {
  const [deleteConf,   setDeleteConf]   = useState(false);
  const [deactivConf,  setDeactivConf]  = useState(false);
  const [fcPoints,     setFcPoints]     = useState<ForecastPoint[] | null>(null);
  const [historical,   setHistorical]   = useState<WCORecord[]>([]);
  const [fcLoading,    setFcLoading]    = useState(true);
  const [fcError,      setFcError]      = useState<string | null>(null);
  const [trainMeta,    setTrainMeta]    = useState<{ model_version: string | null; mae: number | null; rmse: number | null; r2: number | null } | null>(null);

  useEffect(() => {
    setFcLoading(true); setFcError(null);
    Promise.all([
      apiFetch<{ points: ForecastPoint[]; model_version?: string }>(`/forecast/${e.id}?horizon_weeks=13`),
      apiFetch<WCORecord[]>(`/wco/records?establishment_id=${e.id}`),
      apiFetch<{ model_version: string | null; metrics: { mae: number; rmse: number; r2: number } | null }>("/forecast/training-status").catch(() => null),
    ])
      .then(([fc, recs, ts]) => {
        setFcPoints(fc.points);
        setHistorical(recs);
        if (ts) setTrainMeta({ model_version: ts.model_version, mae: ts.metrics?.mae ?? null, rmse: ts.metrics?.rmse ?? null, r2: ts.metrics?.r2 ?? null });
      })
      .catch(err => setFcError(String(err).replace(/^(Type)?Error:\s*/, "")))
      .finally(() => setFcLoading(false));
  }, [e.id]);

  return (
    <div style={MO.overlay} onClick={onClose}>
      <div style={{ ...MO.modal, maxWidth: 680 }} onClick={ev => ev.stopPropagation()}>
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
              <TypeBadge type={e.type} />
              <StatusBadge active={e.is_active} />
            </div>
            <h2 style={{ fontSize: 18, fontWeight: 900, color: "#111827", margin: "0 0 2px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.name}</h2>
            <div style={{ fontSize: 12, color: "#64748b", display: "flex", gap: 12, flexWrap: "wrap" }}>
              <span style={{ fontFamily: "monospace", fontWeight: 700, color: "#0f6e56" }}>{e.wco_code}</span>
              {e.barangay && <span>{e.barangay}</span>}
              <span style={{ color: "#94a3b8" }}>{e.latitude.toFixed(4)}, {e.longitude.toFixed(4)}</span>
            </div>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 18, cursor: "pointer", color: "#94a3b8", padding: "2px 6px", flexShrink: 0 }}>✕</button>
        </div>

        {/* Action buttons */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, paddingBottom: 18, borderBottom: "1px solid #f1f5f9", marginBottom: 20 }}>
          <button onClick={() => onViewWCO(e)} style={{ ...ghostBtn, fontSize: 12, padding: "6px 14px", color: "#0f6e56", borderColor: "#86efac" }}>
            WCO Records
          </button>
          <button onClick={() => onViewTests(e)} style={{ ...ghostBtn, fontSize: 12, padding: "6px 14px", color: "#7c3aed", borderColor: "#c4b5fd" }}>
            Quality Tests
          </button>
          <div style={{ flex: 1 }} />
          <RoleGuard action="edit">
            <button onClick={() => onEdit(e)} style={{ ...ghostBtn, fontSize: 12, padding: "6px 14px" }}>Edit</button>
            {e.is_active ? (
              deactivConf ? (
                <>
                  <button onClick={() => { onToggleActive(e); setDeactivConf(false); onClose(); }} style={{ ...ghostBtn, fontSize: 12, padding: "6px 14px", color: "#dc2626", borderColor: "#fca5a5" }}>Confirm deactivate</button>
                  <button onClick={() => setDeactivConf(false)} style={{ ...ghostBtn, fontSize: 12, padding: "6px 14px" }}>Cancel</button>
                </>
              ) : (
                <button onClick={() => setDeactivConf(true)} style={{ ...ghostBtn, fontSize: 12, padding: "6px 14px", color: "#dc2626", borderColor: "#fca5a5" }}>Deactivate</button>
              )
            ) : (
              <button onClick={() => { onToggleActive(e); onClose(); }} style={{ ...ghostBtn, fontSize: 12, padding: "6px 14px", color: "#065f46", borderColor: "#86efac" }}>Activate</button>
            )}
          </RoleGuard>
          <RoleGuard action="delete">
            {deleteConf ? (
              <>
                <button onClick={() => onDelete(e.id)} style={{ ...ghostBtn, fontSize: 12, padding: "6px 14px", color: "#dc2626", borderColor: "#fca5a5" }}>Confirm delete</button>
                <button onClick={() => setDeleteConf(false)} style={{ ...ghostBtn, fontSize: 12, padding: "6px 14px" }}>Cancel</button>
              </>
            ) : (
              <button onClick={() => setDeleteConf(true)} style={{ ...ghostBtn, fontSize: 12, padding: "6px 14px", color: "#dc2626", borderColor: "#fca5a5" }}>Delete</button>
            )}
          </RoleGuard>
        </div>

        {/* 3-month LSTM Forecast (inline) */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.06em" }}>
              3-Month LSTM Forecast
            </div>
            {trainMeta && (
              <div style={{ display: "flex", gap: 10, marginTop: 4, flexWrap: "wrap" }}>
                {trainMeta.model_version && (
                  <span style={{ fontSize: 10, color: "#94a3b8" }}>v{trainMeta.model_version}</span>
                )}
                {trainMeta.mae != null && (
                  <span style={{ fontSize: 10, color: "#94a3b8" }}>MAE {trainMeta.mae} L</span>
                )}
                {trainMeta.rmse != null && (
                  <span style={{ fontSize: 10, color: "#94a3b8" }}>RMSE {trainMeta.rmse} L</span>
                )}
                {trainMeta.r2 != null && (
                  <span style={{ fontSize: 10, fontWeight: 700, color: trainMeta.r2 >= 0.8 ? "#0f6e56" : trainMeta.r2 >= 0.6 ? "#d97706" : "#dc2626" }}>
                    R² {trainMeta.r2.toFixed(3)}
                  </span>
                )}
              </div>
            )}
          </div>
          {fcPoints && fcPoints.length > 0 && (
            <button onClick={() => printForecastChart(e.name, e.wco_code)} style={{ ...ghostBtn, fontSize: 10, padding: "3px 10px", color: "#374151" }}>
              Export PDF
            </button>
          )}
        </div>
        <div id="detail-forecast-chart">
          {fcLoading ? (
            <div style={{ height: 160, display: "flex", alignItems: "center", justifyContent: "center", color: "#94a3b8", fontSize: 12 }}>Loading forecast…</div>
          ) : fcError ? (
            <div style={{ padding: "10px 14px", background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 10, fontSize: 13, color: "#dc2626" }}>
              {fcError.includes("503") || fcError.includes("No trained") || fcError.includes("404")
                ? "No trained model yet — go to Admin → Forecasting and train the LSTM first."
                : fcError}
            </div>
          ) : fcPoints ? (
            <ForecastChart points={fcPoints} historical={historical} />
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

function EstablishmentsContent() {
  const [all,        setAll]        = useState<Establishment[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState<string | null>(null);
  const [search,     setSearch]     = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [showAll,    setShowAll]    = useState(false);
  const [modal,       setModal]       = useState<null | "add" | Establishment>(null);
  const [detailModal, setDetailModal] = useState<Establishment | null>(null);
  const [wcoModal,    setWcoModal]    = useState<Establishment | null>(null);
  const [qualityModal,setQualityModal]= useState<Establishment | null>(null);
  const [sortKey,        setSortKey]        = useState<string | null>(null);
  const [selected,       setSelected]       = useState<Set<number>>(new Set());
  const [batchDelConf,   setBatchDelConf]   = useState(false);
  const [batchDeleting,  setBatchDeleting]  = useState(false);
  const [sortDir,        setSortDir]        = useState<"asc" | "desc">("asc");
  const [importStatus,   setImportStatus]   = useState<string | null>(null);
  const [importing,      setImporting]      = useState(false);
  const [lastCollection, setLastCollection] = useState<Record<string, string>>({});
  const [exportOpen,     setExportOpen]     = useState(false);
  const estabFileRef = useRef<HTMLInputElement>(null);

  function toggleSort(key: string) {
    if (sortKey === key) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortKey(key); setSortDir("asc"); }
  }

  function toggleSelect(id: number) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    if (selected.size === sorted.length && sorted.length > 0)
      setSelected(new Set());
    else
      setSelected(new Set(sorted.map(e => e.id)));
  }

  async function batchDelete() {
    const count = selected.size;
    setBatchDeleting(true);
    for (const id of selected) {
      try { await apiFetch(`/establishments/${id}`, { method: "DELETE" }); } catch { /* skip */ }
    }
    setSelected(new Set());
    setBatchDelConf(false);
    setBatchDeleting(false);
    toast(`${count} establishment${count !== 1 ? "s" : ""} deleted.`, "info");
    await load();
  }

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch<Establishment[]>(`/establishments?active_only=false`);
      setAll(data);
    } catch (e) { setError(String(e)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!all.length) return;
    apiFetch<Record<string, string>>("/wco/last-collection")
      .then(d => setLastCollection(d))
      .catch(() => {});
  }, [all]);

  const refreshLastCollection = useCallback(() => {
    apiFetch<Record<string, string>>("/wco/last-collection")
      .then(d => setLastCollection(d))
      .catch(() => {});
  }, []);

  const displayed = all.filter(e => {
    if (!showAll && !e.is_active) return false;
    if (typeFilter !== "all" && e.type !== typeFilter) return false;
    const q = search.toLowerCase();
    return !q || e.name.toLowerCase().includes(q) || e.wco_code.toLowerCase().includes(q) || (e.barangay ?? "").toLowerCase().includes(q);
  });

  const sorted = [...displayed].sort((a, b) => {
    if (!sortKey) return 0;
    let av: string | number, bv: string | number;
    switch (sortKey) {
      case "wco_code":  av = a.wco_code;          bv = b.wco_code;          break;
      case "name":      av = a.name;               bv = b.name;              break;
      case "type":      av = a.type;               bv = b.type;              break;
      case "barangay":  av = a.barangay ?? "";     bv = b.barangay ?? "";    break;
      case "status":    av = a.is_active ? 1 : 0;  bv = b.is_active ? 1 : 0; break;
      default: return 0;
    }
    if (av < bv) return sortDir === "asc" ? -1 : 1;
    if (av > bv) return sortDir === "asc" ? 1 : -1;
    return 0;
  });

  async function toggleActive(e: Establishment) {
    try {
      const updated = await apiFetch<Establishment>(`/establishments/${e.id}`, {
        method: "PATCH",
        body: JSON.stringify({ is_active: !e.is_active }),
      });
      setAll(prev => prev.map(x => x.id === updated.id ? updated : x));
      toast(updated.is_active ? "Establishment activated." : "Establishment deactivated.", "info");
    } catch (err) { toast(String(err).replace(/^(Type)?Error:\s*/, ""), "error"); }
  }

  async function deleteEst(id: number) {
    try {
      await apiFetch(`/establishments/${id}`, { method: "DELETE" });
      setDetailModal(null);
      toast("Establishment deleted.", "info");
      await load();
    } catch (err) { toast(String(err).replace(/^(Type)?Error:\s*/, ""), "error"); }
  }

  function onSaved(saved: Establishment) {
    setAll(prev => {
      const exists = prev.find(x => x.id === saved.id);
      return exists ? prev.map(x => x.id === saved.id ? saved : x) : [saved, ...prev];
    });
  }

  async function handleEstabCSV(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    setImporting(true); setImportStatus(null);
    const text = await file.text();
    const lines = text.trim().split(/\r?\n/);
    if (lines.length < 2) { setImporting(false); setImportStatus("CSV empty or missing header."); return; }
    const headers = lines[0].split(",").map(h => h.trim().toLowerCase().replace(/^"|"$/g, ""));
    const rows = lines.slice(1).filter(l => l.trim()).map(line => {
      const vals = line.split(",").map(v => v.trim().replace(/^"|"$/g, ""));
      const row: Record<string, string> = {};
      headers.forEach((h, i) => { row[h] = vals[i] ?? ""; });
      return row;
    });
    const find = (row: Record<string, string>, ...keys: string[]) => {
      for (const k of keys) { const v = row[k]; if (v != null) return v; } return "";
    };
    const payload = rows.map(row => ({
      wco_code: find(row, "wco_code", "code"),
      name: find(row, "name"),
      type: find(row, "type") || "restaurant",
      latitude: parseFloat(find(row, "latitude", "lat")),
      longitude: parseFloat(find(row, "longitude", "lng", "lon")),
      barangay: find(row, "barangay") || null,
      consent_given: true,
    })).filter(r => r.wco_code && r.name && !isNaN(r.latitude) && !isNaN(r.longitude));
    if (!payload.length) { setImporting(false); setImportStatus("No valid rows found. Check headers: wco_code,name,type,latitude,longitude,barangay"); return; }
    try {
      const res = await apiFetch<{ imported: number; skipped: number }>("/establishments/bulk", {
        method: "POST", body: JSON.stringify(payload),
      });
      setImportStatus(`${res.imported} imported, ${res.skipped} skipped.`);
      toast(`${res.imported} establishment${res.imported !== 1 ? "s" : ""} imported.`);
      await load();
    } catch (err) { setImportStatus(String(err).replace(/^(Type)?Error:\s*/, "")); toast(String(err).replace(/^(Type)?Error:\s*/, ""), "error"); }
    finally { setImporting(false); }
  }

  function exportGeoJSON() {
    const features = sorted.map(est => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [est.longitude, est.latitude] },
      properties: { wco_code: est.wco_code, name: est.name, type: est.type, barangay: est.barangay, is_active: est.is_active },
    }));
    const blob = new Blob([JSON.stringify({ type: "FeatureCollection", features }, null, 2)], { type: "application/geo+json" });
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: "establishments.geojson" });
    a.click(); URL.revokeObjectURL(a.href);
  }

  async function exportExcel() {
    const XLSX = await import("xlsx");
    const data = sorted.map(est => ({
      WCO_Code: est.wco_code,
      Name: est.name,
      Type: est.type,
      Barangay: est.barangay ?? "",
      Latitude: est.latitude,
      Longitude: est.longitude,
      Status: est.is_active ? "Active" : "Inactive",
      Last_Collection: lastCollection[est.id] ?? "",
    }));
    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Establishments");
    XLSX.writeFile(wb, "establishments.xlsx");
  }

  const active   = all.filter(e => e.is_active).length;
  const inactive = all.filter(e => !e.is_active).length;

  return (
    <PageShell
      title="Establishments"
      subtitle={`${active} active · ${inactive} inactive · ${all.length} total`}
      action={
        <RoleGuard action="edit">
          <button style={primaryBtn} onClick={() => setModal("add")}>+ Add establishment</button>
        </RoleGuard>
      }
    >
      {/* Summary cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))", gap: 12, marginBottom: 20 }}>
        {[
          { label: "Total",        value: all.length,  color: "#1a202c" },
          { label: "Active",       value: active,      color: "#065f46" },
          { label: "Restaurants",  value: all.filter(e=>e.type==="restaurant").length,        color: "#065f46" },
          { label: "Fast Food",    value: all.filter(e=>e.type==="fast_food").length,         color: "#9a3412" },
          { label: "Food Mfr.",    value: all.filter(e=>e.type==="food_manufacturer").length, color: "#1e40af" },
        ].map(({ label: lbl, value, color }) => (
          <div key={lbl} style={{ ...card, padding: "14px 18px" }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 4 }}>{lbl}</div>
            <div style={{ fontSize: 26, fontWeight: 900, color, fontVariantNumeric: "tabular-nums" }}>{value}</div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div style={{ ...card, padding: "12px 16px", marginBottom: 16, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <input
          style={{ ...input, width: 240, marginBottom: 0 }}
          placeholder="Search by name, code, barangay…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <select style={{ ...input, width: 180, marginBottom: 0 }} value={typeFilter} onChange={e => setTypeFilter(e.target.value)}>
          <option value="all">All types</option>
          <option value="restaurant">Restaurant</option>
          <option value="fast_food">Fast Food</option>
          <option value="food_manufacturer">Food Manufacturer</option>
        </select>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "#64748b", cursor: "pointer", userSelect: "none" }}>
          <input type="checkbox" checked={showAll} onChange={e => setShowAll(e.target.checked)} />
          Show inactive
        </label>
        {/* Export dropdown */}
        <div style={{ position: "relative" }}>
          <button
            onClick={() => setExportOpen(v => !v)}
            style={{ ...ghostBtn, fontSize: 11, padding: "4px 10px", display: "flex", alignItems: "center", gap: 4 }}
          >
            Export <span style={{ fontSize: 9, opacity: 0.6 }}>▾</span>
          </button>
          {exportOpen && (
            <>
              <div style={{ position: "fixed", inset: 0, zIndex: 98 }} onClick={() => setExportOpen(false)} />
              <div style={{
                position: "absolute", top: "calc(100% + 4px)", left: 0, zIndex: 99,
                background: "white", borderRadius: 10, border: "1px solid #e2e8f0",
                boxShadow: "0 4px 16px rgba(0,0,0,0.10)", minWidth: 150, overflow: "hidden",
              }}>
                {[
                  {
                    label: "CSV",
                    color: "#374151",
                    action: () => {
                      downloadCSV(sorted.map(e => ({
                        wco_code: e.wco_code, name: e.name, type: e.type,
                        barangay: e.barangay ?? "", latitude: e.latitude, longitude: e.longitude,
                        status: e.is_active ? "active" : "inactive",
                        last_collection: lastCollection[e.id] ?? "",
                      })), "establishments.csv");
                      setExportOpen(false);
                    },
                  },
                  { label: "Excel (.xlsx)", color: "#065f46", action: () => { exportExcel(); setExportOpen(false); } },
                  { label: "GeoJSON", color: "#1d4ed8", action: () => { exportGeoJSON(); setExportOpen(false); } },
                ].map(({ label, color, action }) => (
                  <button
                    key={label}
                    onClick={action}
                    style={{
                      display: "block", width: "100%", textAlign: "left",
                      padding: "9px 14px", fontSize: 12, fontWeight: 600,
                      color, background: "none", border: "none",
                      cursor: "pointer", fontFamily: "inherit",
                      borderBottom: label !== "GeoJSON" ? "1px solid #f1f5f9" : "none",
                    }}
                    onMouseEnter={e => (e.currentTarget.style.background = "#f8fafc")}
                    onMouseLeave={e => (e.currentTarget.style.background = "none")}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
        <RoleGuard action="edit">
          <input ref={estabFileRef} type="file" accept=".csv" style={{ display: "none" }} onChange={handleEstabCSV} />
          <button
            onClick={() => { setImportStatus(null); estabFileRef.current?.click(); }}
            disabled={importing}
            style={{ ...ghostBtn, fontSize: 11, padding: "4px 10px", opacity: importing ? 0.6 : 1 }}
          >
            {importing ? "Importing…" : "Import CSV"}
          </button>
        </RoleGuard>
        {importStatus && <span style={{ fontSize: 11, color: importStatus.includes("imported") ? "#0f6e56" : "#dc2626", fontWeight: 600 }}>{importStatus}</span>}
        <span style={{ fontSize: 12, color: "#94a3b8" }}>{sorted.length} shown</span>
        {(search || typeFilter !== "all" || showAll || sortKey) && (
          <button
            onClick={() => { setSearch(""); setTypeFilter("all"); setShowAll(false); setSortKey(null); setSortDir("asc"); }}
            style={{ ...ghostBtn, fontSize: 11, padding: "4px 10px", color: "#dc2626", borderColor: "#fca5a5" }}
          >
            Reset filters
          </button>
        )}
      </div>

      {/* Batch action bar */}
      {selected.size > 0 && (
        <div style={{ background: "#1a202c", borderRadius: 12, padding: "10px 16px", display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: "white" }}>{selected.size} selected</span>
          <button onClick={() => setSelected(new Set())} style={{ fontSize: 12, color: "#94a3b8", background: "none", border: "none", cursor: "pointer", fontFamily: "inherit" }}>Clear</button>
          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            {batchDelConf ? (
              <>
                <button onClick={batchDelete} disabled={batchDeleting} style={{ fontSize: 12, padding: "6px 14px", borderRadius: 8, border: "none", background: "#dc2626", color: "white", fontWeight: 700, cursor: "pointer", fontFamily: "inherit", opacity: batchDeleting ? 0.7 : 1 }}>
                  {batchDeleting ? "Deleting…" : `Confirm delete ${selected.size}`}
                </button>
                <button onClick={() => setBatchDelConf(false)} style={{ fontSize: 12, padding: "6px 14px", borderRadius: 8, border: "1px solid #4a5568", background: "none", color: "#94a3b8", cursor: "pointer", fontFamily: "inherit" }}>Cancel</button>
              </>
            ) : (
              <RoleGuard action="delete">
                <button onClick={() => setBatchDelConf(true)} style={{ fontSize: 12, padding: "6px 14px", borderRadius: 8, border: "none", background: "#fee2e2", color: "#dc2626", fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
                  Delete {selected.size} selected
                </button>
              </RoleGuard>
            )}
          </div>
        </div>
      )}

      {/* Table */}
      <div style={{ ...card, padding: 0, overflow: "hidden" }}>
        {error && (
          <div style={{ padding: "12px 20px", background: "#fef2f2", color: "#dc2626", fontSize: 13 }}>{error}</div>
        )}
        {loading ? (
          <div style={{ padding: "48px 0", textAlign: "center", color: "#94a3b8", fontSize: 13 }}>Loading…</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ background: "#f8fafc" }}>
                  {/* Select-all checkbox */}
                  <th style={{ ...TH, width: 40, paddingLeft: 16 }}>
                    <input
                      type="checkbox"
                      checked={sorted.length > 0 && selected.size === sorted.length}
                      onChange={toggleSelectAll}
                      style={{ cursor: "pointer" }}
                    />
                  </th>
                  {([
                    { label: "Code",            key: "wco_code"  },
                    { label: "Name",            key: "name"      },
                    { label: "Type",            key: "type"      },
                    { label: "Barangay",        key: "barangay"  },
                    { label: "Coordinates",     key: null        },
                    { label: "Last Collection", key: null        },
                    { label: "Status",          key: "status"    },
                    { label: "",                key: null        },
                  ] as { label: string; key: string | null }[]).map(({ label, key }) => (
                    <th
                      key={label}
                      onClick={key ? () => toggleSort(key) : undefined}
                      style={{
                        ...TH,
                        cursor: key ? "pointer" : "default",
                        userSelect: "none",
                        whiteSpace: "nowrap",
                      }}
                    >
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                        {label}
                        {key && (
                          <span style={{ fontSize: 10, color: sortKey === key ? "#0f6e56" : "#cbd5e1", fontWeight: 900, lineHeight: 1 }}>
                            {sortKey === key ? (sortDir === "asc" ? "↑" : "↓") : "↕"}
                          </span>
                        )}
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sorted.length === 0 ? (
                  <tr>
                    <td colSpan={9} style={{ padding: "40px 0", textAlign: "center", color: "#94a3b8" }}>
                      No establishments match your filters.
                    </td>
                  </tr>
                ) : sorted.map((e, i) => (
                  <tr key={e.id} style={{ background: selected.has(e.id) ? "#f0fdf4" : i % 2 === 0 ? "white" : "#fafafa", opacity: e.is_active ? 1 : 0.5 }}>
                    <td style={{ ...TD, paddingLeft: 16, width: 40 }}>
                      <input type="checkbox" checked={selected.has(e.id)} onChange={() => toggleSelect(e.id)} style={{ cursor: "pointer" }} />
                    </td>
                    <td style={{ ...TD, fontFamily: "monospace", fontWeight: 700, color: "#0f6e56", fontSize: 12 }}>{e.wco_code}</td>
                    <td style={{ ...TD, fontWeight: 600, color: "#111827", maxWidth: 220 }}>
                      <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.name}</div>
                    </td>
                    <td style={TD}><TypeBadge type={e.type} /></td>
                    <td style={{ ...TD, color: "#64748b" }}>{e.barangay ?? "—"}</td>
                    <td style={{ ...TD, color: "#94a3b8", fontFamily: "monospace", fontSize: 11 }}>
                      {e.latitude.toFixed(4)}, {e.longitude.toFixed(4)}
                    </td>
                    <td style={{ ...TD, color: "#64748b", fontSize: 11, whiteSpace: "nowrap" }}>
                      {lastCollection[e.id]
                        ? new Date(lastCollection[e.id]).toLocaleDateString("en-PH", { year: "numeric", month: "short", day: "numeric" })
                        : <span style={{ color: "#d1d5db" }}>—</span>}
                    </td>
                    <td style={TD}><StatusBadge active={e.is_active} /></td>
                    <td style={{ ...TD, whiteSpace: "nowrap" }}>
                      <button
                        onClick={() => setDetailModal(e)}
                        style={{ ...ghostBtn, fontSize: 11, padding: "4px 12px" }}
                      >
                        View Details
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Modals */}
      {modal !== null && (
        <EstablishmentModal
          initial={modal === "add" ? null : modal as Establishment}
          onClose={() => setModal(null)}
          onSaved={onSaved}
        />
      )}

      {detailModal && (
        <EstablishmentDetailModal
          establishment={detailModal}
          onClose={() => setDetailModal(null)}
          onEdit={e => { setDetailModal(null); setModal(e); }}
          onViewWCO={e => setWcoModal(e)}
          onViewTests={e => setQualityModal(e)}
          onToggleActive={e => { toggleActive(e); setDetailModal(prev => prev ? { ...prev, is_active: !prev.is_active } : null); }}
          onDelete={id => deleteEst(id)}
        />
      )}

      {wcoModal && (
        <WCORecordsModal
          establishment={wcoModal}
          onClose={() => setWcoModal(null)}
          onRecordChanged={refreshLastCollection}
        />
      )}
      {qualityModal && (
        <QualityTestsModal establishment={qualityModal} onClose={() => setQualityModal(null)} />
      )}
    </PageShell>
  );
}

export default function EstablishmentsPage() {
  return (
    <ProtectedRoute>
      <div style={{ height: "100vh", display: "flex", flexDirection: "column", fontFamily: "system-ui, sans-serif" }}>
        <Navbar />
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
          <EstablishmentsContent />
        </div>
      </div>
      <Toaster />
    </ProtectedRoute>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const TH: React.CSSProperties = {
  padding: "10px 16px", textAlign: "left", fontSize: 11,
  fontWeight: 700, color: "#64748b", letterSpacing: "0.05em",
  textTransform: "uppercase", borderBottom: "1px solid #e2e8f0",
  whiteSpace: "nowrap",
};
const TD: React.CSSProperties = {
  padding: "10px 16px", borderBottom: "1px solid #f1f5f9",
  verticalAlign: "middle",
};
const MO: Record<string, React.CSSProperties> = {
  overlay: {
    position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)",
    backdropFilter: "blur(4px)", display: "flex",
    alignItems: "center", justifyContent: "center", zIndex: 9999,
    padding: 16,
  },
  modal: {
    background: "white", borderRadius: 20, padding: 28,
    width: "100%", maxWidth: 560, maxHeight: "90vh",
    overflowY: "auto",
    boxShadow: "0 20px 60px rgba(0,0,0,0.2)",
  },
};
