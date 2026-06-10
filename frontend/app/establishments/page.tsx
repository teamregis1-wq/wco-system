"use client";

import { useEffect, useState, useCallback } from "react";
import dynamic from "next/dynamic";
import ProtectedRoute from "@/components/ProtectedRoute";
import { RoleGuard } from "@/components/ProtectedRoute";
import Navbar from "@/components/Navbar";
import PageShell, { card, primaryBtn, ghostBtn, input, label } from "@/components/PageShell";
import { getToken } from "@/lib/api";

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
  barangay: string; consent_given: boolean;
};

const EMPTY_FORM: FormData = {
  wco_code: "", name: "", type: "restaurant",
  latitude: "", longitude: "", barangay: "",
  consent_given: false,
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
          consent_given: initial.consent_given,
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
        consent_given: form.consent_given,
      };
      if (!editing) body.wco_code = form.wco_code;
      if (form.barangay) body.barangay = form.barangay;

      const saved = editing
        ? await apiFetch<Establishment>(`/establishments/${initial!.id}`, { method: "PATCH", body: JSON.stringify(body) })
        : await apiFetch<Establishment>("/establishments", { method: "POST", body: JSON.stringify(body) });

      onSaved(saved);
      onClose();
    } catch (err) {
      setError(String(err).replace("Error: ", ""));
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

          <div style={{ marginBottom: 16 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 13, color: "#374151" }}>
              <input type="checkbox" checked={form.consent_given} onChange={e => set("consent_given", e.target.checked)} style={{ width: 16, height: 16 }} />
              <span>Owner has given consent for data collection</span>
            </label>
          </div>

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
}: {
  establishment: Establishment;
  onClose: () => void;
}) {
  const [records,     setRecords]     = useState<WCORecord[]>([]);
  const [loading,     setLoading]     = useState(true);
  const [error,       setError]       = useState<string | null>(null);
  const [deleteConf,  setDeleteConf]  = useState<number | null>(null);

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
      const data = await apiFetch<WCORecord[]>(`/wco/records?establishment_id=${establishment.id}`);
      setRecords(data);
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
    } catch (err) {
      setAddError(String(err).replace("Error: ", ""));
    } finally {
      setAddBusy(false);
    }
  }

  async function deleteRecord(id: number) {
    try {
      await apiFetch(`/wco/records/${id}`, { method: "DELETE" });
      setRecords(prev => prev.filter(r => r.id !== id));
      setDeleteConf(null);
    } catch (err) { alert(String(err)); }
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
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 18, cursor: "pointer", color: "#94a3b8", padding: "2px 6px" }}>✕</button>
        </div>

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
                    <td style={{ padding: "9px 12px", borderBottom: "1px solid #f1f5f9", color: "#0f6e56", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
                      {r.quantity_liters.toLocaleString(undefined, { maximumFractionDigits: 1 })} L
                    </td>
                    <td style={{ padding: "9px 12px", borderBottom: "1px solid #f1f5f9", color: "#64748b", fontSize: 12 }}>
                      {r.notes ?? "—"}
                    </td>
                    <td style={{ padding: "9px 12px", borderBottom: "1px solid #f1f5f9", whiteSpace: "nowrap" }}>
                      <RoleGuard action="edit">
                        {deleteConf === r.id ? (
                          <div style={{ display: "flex", gap: 4 }}>
                            <button onClick={() => deleteRecord(r.id)} style={{ ...ghostBtn, fontSize: 11, padding: "3px 8px", color: "#dc2626", borderColor: "#fca5a5" }}>Confirm</button>
                            <button onClick={() => setDeleteConf(null)} style={{ ...ghostBtn, fontSize: 11, padding: "3px 8px" }}>Cancel</button>
                          </div>
                        ) : (
                          <button onClick={() => setDeleteConf(r.id)} style={{ ...ghostBtn, fontSize: 11, padding: "3px 8px", color: "#dc2626", borderColor: "#fca5a5" }}>
                            Delete
                          </button>
                        )}
                      </RoleGuard>
                    </td>
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
    } catch (err) { setAddError(String(err).replace("Error: ", "")); }
    finally { setAddBusy(false); }
  }

  async function del(id: number) {
    try {
      await apiFetch(`/quality-tests/${id}`, { method: "DELETE" });
      setTests(prev => prev.filter(t => t.id !== id)); setDeleteConf(null);
    } catch (err) { alert(String(err)); }
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

// ── Main component ────────────────────────────────────────────────────────────

function EstablishmentsContent() {
  const [all,        setAll]        = useState<Establishment[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState<string | null>(null);
  const [search,     setSearch]     = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [showAll,    setShowAll]    = useState(false);
  const [modal,          setModal]          = useState<null | "add" | Establishment>(null);
  const [deleteConf,     setDeleteConf]     = useState<number | null>(null);
  const [deactivateConf, setDeactivateConf] = useState<number | null>(null);
  const [wcoModal,       setWcoModal]       = useState<Establishment | null>(null);
  const [sortKey,        setSortKey]        = useState<string | null>(null);
  const [selected,       setSelected]       = useState<Set<number>>(new Set());
  const [batchDelConf,   setBatchDelConf]   = useState(false);
  const [batchDeleting,  setBatchDeleting]  = useState(false);
  const [sortDir,        setSortDir]        = useState<"asc" | "desc">("asc");

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
    setBatchDeleting(true);
    for (const id of selected) {
      try { await apiFetch(`/establishments/${id}`, { method: "DELETE" }); } catch { /* skip */ }
    }
    setSelected(new Set());
    setBatchDelConf(false);
    setBatchDeleting(false);
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
    } catch (err) { alert(String(err)); }
  }

  async function deleteEst(id: number) {
    try {
      await apiFetch(`/establishments/${id}`, { method: "DELETE" });
      await load();
      setDeleteConf(null);
    } catch (err) { alert(String(err)); }
  }

  function onSaved(saved: Establishment) {
    setAll(prev => {
      const exists = prev.find(x => x.id === saved.id);
      return exists ? prev.map(x => x.id === saved.id ? saved : x) : [saved, ...prev];
    });
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
        <button
          onClick={() => downloadCSV(sorted.map(e => ({
            wco_code: e.wco_code, name: e.name, type: e.type,
            barangay: e.barangay ?? "", latitude: e.latitude, longitude: e.longitude,
            status: e.is_active ? "active" : "inactive",
          })), "establishments.csv")}
          style={{ ...ghostBtn, fontSize: 11, padding: "4px 10px" }}
        >
          Export CSV
        </button>
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
                    { label: "Code",        key: "wco_code"  },
                    { label: "Name",        key: "name"      },
                    { label: "Type",        key: "type"      },
                    { label: "Barangay",    key: "barangay"  },
                    { label: "Coordinates", key: null        },
                    { label: "Status",      key: "status"    },
                    { label: "Actions",     key: null        },
                  ] as { label: string; key: string | null }[]).map(({ label, key }) => (
                    <th
                      key={label}
                      onClick={key ? () => toggleSort(key) : undefined}
                      style={{
                        ...(label === "Actions" ? { ...TH, width: 320, minWidth: 320 } : TH),
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
                    <td colSpan={8} style={{ padding: "40px 0", textAlign: "center", color: "#94a3b8" }}>
                      No establishments match your filters.
                    </td>
                  </tr>
                ) : sorted.map((e, i) => (
                  <tr key={e.id} style={{ background: selected.has(e.id) ? "#f0fdf4" : i % 2 === 0 ? "white" : "#fafafa", opacity: e.is_active ? 1 : 0.5 }}>
                    <td style={{ ...TD, paddingLeft: 16, width: 40 }}>
                      <input type="checkbox" checked={selected.has(e.id)} onChange={() => toggleSelect(e.id)} style={{ cursor: "pointer" }} />
                    </td>
                    <td style={{ ...TD, fontFamily: "monospace", fontWeight: 700, color: "#0f6e56", fontSize: 12 }}>{e.wco_code}</td>
                    <td style={{ ...TD, fontWeight: 600, color: "#111827", maxWidth: 200 }}>
                      <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.name}</div>
                    </td>
                    <td style={TD}><TypeBadge type={e.type} /></td>
                    <td style={{ ...TD, color: "#64748b" }}>{e.barangay ?? "—"}</td>
                    <td style={{ ...TD, color: "#94a3b8", fontFamily: "monospace", fontSize: 11 }}>
                      {e.latitude.toFixed(4)}, {e.longitude.toFixed(4)}
                    </td>
                    <td style={TD}><StatusBadge active={e.is_active} /></td>
                    <td style={{ ...TD, whiteSpace: "nowrap", width: 320, minWidth: 320 }}>
                      <div style={{ display: "flex", gap: 6, flexWrap: "nowrap" }}>
                        {/* WCO Records — all authenticated users */}
                        <button onClick={() => setWcoModal(e)} style={{ ...ghostBtn, fontSize: 11, padding: "4px 10px", color: "#0f6e56", borderColor: "#86efac" }}>
                          WCO Records
                        </button>

                        <RoleGuard action="edit">
                          <button
                            onClick={() => setModal(e)}
                            style={{ ...ghostBtn, fontSize: 11, padding: "4px 10px" }}
                          >
                            Edit
                          </button>

                          {/* Deactivate with inline confirm / Activate directly */}
                          {e.is_active ? (
                            deactivateConf === e.id ? (
                              <>
                                <button
                                  onClick={() => { toggleActive(e); setDeactivateConf(null); }}
                                  style={{ ...ghostBtn, fontSize: 11, padding: "4px 10px", color: "#dc2626", borderColor: "#fca5a5" }}
                                >
                                  Confirm
                                </button>
                                <button
                                  onClick={() => setDeactivateConf(null)}
                                  style={{ ...ghostBtn, fontSize: 11, padding: "4px 10px" }}
                                >
                                  Cancel
                                </button>
                              </>
                            ) : (
                              <button
                                onClick={() => setDeactivateConf(e.id)}
                                style={{ ...ghostBtn, fontSize: 11, padding: "4px 10px", color: "#dc2626", borderColor: "#fca5a5" }}
                              >
                                Deactivate
                              </button>
                            )
                          ) : (
                            <button
                              onClick={() => toggleActive(e)}
                              style={{ ...ghostBtn, fontSize: 11, padding: "4px 10px", color: "#065f46", borderColor: "#86efac" }}
                            >
                              Activate
                            </button>
                          )}
                        </RoleGuard>

                        <RoleGuard action="delete">
                          {deleteConf === e.id ? (
                            <>
                              <button onClick={() => deleteEst(e.id)} style={{ ...ghostBtn, fontSize: 11, padding: "4px 10px", color: "#dc2626", borderColor: "#fca5a5" }}>Confirm</button>
                              <button onClick={() => setDeleteConf(null)} style={{ ...ghostBtn, fontSize: 11, padding: "4px 10px" }}>Cancel</button>
                            </>
                          ) : (
                            <button onClick={() => setDeleteConf(e.id)} style={{ ...ghostBtn, fontSize: 11, padding: "4px 10px", color: "#dc2626", borderColor: "#fca5a5" }}>
                              Delete
                            </button>
                          )}
                        </RoleGuard>
                      </div>
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

      {wcoModal && (
        <WCORecordsModal establishment={wcoModal} onClose={() => setWcoModal(null)} />
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
