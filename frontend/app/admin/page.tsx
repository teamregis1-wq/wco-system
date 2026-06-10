"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import ProtectedRoute from "@/components/ProtectedRoute";
import Navbar from "@/components/Navbar";
import PageShell, { card as cardStyle, primaryBtn as primaryBtnStyle, ghostBtn as ghostBtnStyle, input as inputStyle, label as labelStyle } from "@/components/PageShell";
import { getToken } from "@/lib/api";
import { useAuth, type Role } from "@/lib/auth-context";

// ── Types ─────────────────────────────────────────────────────────────────────

interface UserRow {
  id: number;
  email: string;
  full_name: string;
  role: Role;
  created_at: string;
}

interface AuditEntry {
  id: number;
  user_email: string;
  action: string;
  resource_type: string;
  resource_id: number | null;
  details: string | null;
  created_at: string;
}

function downloadCSV(rows: Record<string, unknown>[], filename: string) {
  if (!rows.length) return;
  const headers = Object.keys(rows[0]);
  const escape = (v: unknown) => {
    const s = v == null ? "" : String(v);
    return s.includes(",") || s.includes('"') || s.includes("\n") ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [headers.join(","), ...rows.map(r => headers.map(h => escape(r[h])).join(","))].join("\n");
  const a = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(new Blob([csv], { type: "text/csv" })),
    download: filename,
  });
  a.click(); URL.revokeObjectURL(a.href);
}

interface Stats {
  total_users: number;
  total_establishments: number;
  active_establishments: number;
  total_wco_records: number;
  total_wco_liters: number;
}

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

// ── Role badge ────────────────────────────────────────────────────────────────

const ROLE_STYLE: Record<Role, { bg: string; color: string }> = {
  admin:      { bg: "#fef3c7", color: "#92400e" },
  researcher: { bg: "#dbeafe", color: "#1d4ed8" },
  viewer:     { bg: "#f3f4f6", color: "#374151" },
};

function RoleBadge({ role }: { role: Role }) {
  const s = ROLE_STYLE[role] ?? ROLE_STYLE.viewer;
  return (
    <span style={{
      fontSize: 11, fontWeight: 700, padding: "3px 9px", borderRadius: 99,
      background: s.bg, color: s.color, letterSpacing: "0.05em",
      textTransform: "uppercase",
    }}>
      {role}
    </span>
  );
}

// ── Stat card ─────────────────────────────────────────────────────────────────

function StatCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div style={{ ...cardStyle, padding: "14px 18px" }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: "#718096", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>
        {label}
      </div>
      <div style={{ fontSize: 28, fontWeight: 900, color: "#1a202c", fontVariantNumeric: "tabular-nums", lineHeight: 1 }}>
        {typeof value === "number" ? value.toLocaleString() : value}
      </div>
      {sub && <div style={{ fontSize: 11, color: "#a0aec0", marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

// ── Add user modal ────────────────────────────────────────────────────────────

function AddUserModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [email,    setEmail]    = useState("");
  const [name,     setName]     = useState("");
  const [password, setPassword] = useState("");
  const [role,     setRole]     = useState<Role>("viewer");
  const [busy,     setBusy]     = useState(false);
  const [error,    setError]    = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await apiFetch("/auth/register", {
        method: "POST",
        body: JSON.stringify({ email, full_name: name, password, role }),
      });
      onCreated();
      onClose();
    } catch (err) {
      setError(String(err).replace("Error: ", ""));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={S.modalOverlay} onClick={onClose}>
      <div style={S.modal} onClick={e => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
          <h2 style={{ fontSize: 18, fontWeight: 800, color: "#1a202c", margin: 0 }}>Add user</h2>
          <button onClick={onClose} style={S.iconBtn}>✕</button>
        </div>
        <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div>
            <label style={labelStyle}>Full name</label>
            <input style={inputStyle} value={name} onChange={e => setName(e.target.value)} required placeholder="e.g. Maria Santos" />
          </div>
          <div>
            <label style={labelStyle}>Email</label>
            <input style={inputStyle} type="email" value={email} onChange={e => setEmail(e.target.value)} required placeholder="user@example.com" />
          </div>
          <div>
            <label style={labelStyle}>Password</label>
            <input style={inputStyle} type="password" value={password} onChange={e => setPassword(e.target.value)} required minLength={8} placeholder="Min. 8 characters" />
          </div>
          <div>
            <label style={labelStyle}>Role</label>
            <select style={inputStyle} value={role} onChange={e => setRole(e.target.value as Role)}>
              <option value="viewer">Viewer — read-only</option>
              <option value="researcher">Researcher — can add & edit data</option>
              <option value="admin">Admin — full access</option>
            </select>
          </div>
          {error && (
            <div style={{ padding: "8px 12px", background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 8, fontSize: 13, color: "#dc2626" }}>
              {error}
            </div>
          )}
          <button type="submit" disabled={busy} style={{ ...primaryBtnStyle, marginTop: 4, opacity: busy ? 0.7 : 1 }}>
            {busy ? "Creating…" : "Create user"}
          </button>
        </form>
      </div>
    </div>
  );
}

// ── LSTM Training Panel ───────────────────────────────────────────────────────

interface TrainingStatus {
  status: "idle" | "training" | "done" | "failed";
  metrics: { mae: number; rmse: number; r2: number; mape: number; training_samples: number; val_samples: number; epochs_run: number } | null;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
}

function LSTMTrainingPanel() {
  const [state,    setState]    = useState<TrainingStatus | null>(null);
  const [starting, setStarting] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const s = await apiFetch<TrainingStatus>("/forecast/training-status");
      setState(s);
      if (s.status !== "training" && pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    } catch { /* silent */ }
  }, []);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);

  async function startTraining() {
    setStarting(true);
    try {
      await apiFetch("/forecast/train", { method: "POST" });
      await fetchStatus();
      pollRef.current = setInterval(fetchStatus, 3000);
    } catch (e) { alert(String(e)); }
    finally { setStarting(false); }
  }

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  const s = state;
  const isTraining = s?.status === "training";

  return (
    <div style={cardStyle}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16, flexWrap: "wrap", gap: 8 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 800, color: "#1a202c" }}>LSTM Forecast Model</div>
          <div style={{ fontSize: 12, color: "#a0aec0" }}>Trains on all WCO records in the database · runs on CPU (~30–90 sec)</div>
        </div>
        <button
          onClick={startTraining}
          disabled={starting || isTraining}
          style={{ ...primaryBtnStyle, opacity: (starting || isTraining) ? 0.65 : 1, display: "flex", alignItems: "center", gap: 8 }}
        >
          {isTraining && (
            <span style={{ width: 14, height: 14, border: "2px solid rgba(255,255,255,0.4)", borderTopColor: "white", borderRadius: "50%", animation: "spin 0.8s linear infinite", display: "inline-block" }} />
          )}
          {isTraining ? "Training…" : starting ? "Starting…" : "Retrain LSTM"}
        </button>
      </div>

      {/* Status strip */}
      {s && s.status !== "idle" && (
        <div style={{
          padding: "10px 14px", borderRadius: 10, marginBottom: 14,
          background: s.status === "done" ? "#f0fdf4" : s.status === "failed" ? "#fef2f2" : "#fffbeb",
          border: `1px solid ${s.status === "done" ? "#bbf7d0" : s.status === "failed" ? "#fca5a5" : "#fde68a"}`,
          fontSize: 12, color: s.status === "done" ? "#065f46" : s.status === "failed" ? "#dc2626" : "#92400e",
          display: "flex", alignItems: "center", gap: 8,
        }}>
          <span style={{ fontWeight: 700 }}>
            {s.status === "training" ? "Training in progress…" : s.status === "done" ? "Training complete" : "Training failed"}
          </span>
          {s.error && <span>— {s.error}</span>}
          {s.finished_at && (
            <span style={{ marginLeft: "auto", color: "#94a3b8" }}>
              {new Date(s.finished_at).toLocaleString("en-PH", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
            </span>
          )}
        </div>
      )}

      {/* Metrics */}
      {s?.metrics && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 10 }}>
          {[
            { label: "MAE",    value: `${s.metrics.mae} L`,   sub: "Mean Abs Error" },
            { label: "RMSE",   value: `${s.metrics.rmse} L`,  sub: "Root Mean Sq. Error" },
            { label: "R²",     value: s.metrics.r2.toFixed(4), sub: "Coefficient of determination" },
            { label: "MAPE",   value: `${s.metrics.mape}%`,   sub: "Mean Abs % Error" },
            { label: "Epochs", value: s.metrics.epochs_run,   sub: "Training epochs run" },
            { label: "Samples",value: `${s.metrics.training_samples} / ${s.metrics.val_samples}`, sub: "Train / Val" },
          ].map(({ label, value, sub }) => (
            <div key={label} style={{ background: "#f8fafc", borderRadius: 10, padding: "10px 14px", border: "1px solid #e2e8f0" }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>{label}</div>
              <div style={{ fontSize: 18, fontWeight: 900, color: "#0f6e56", fontVariantNumeric: "tabular-nums" }}>{value}</div>
              <div style={{ fontSize: 10, color: "#94a3b8", marginTop: 2 }}>{sub}</div>
            </div>
          ))}
        </div>
      )}

      {(!s || s.status === "idle") && !s?.metrics && (
        <div style={{ fontSize: 12, color: "#94a3b8" }}>
          No training run yet. Click "Retrain LSTM" to train on current WCO data.
        </div>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

function AdminDashboard() {
  const { user: me } = useAuth();
  const [users,   setUsers]   = useState<UserRow[]>([]);
  const [stats,   setStats]   = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [roleLoading, setRoleLoading] = useState<number | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<number | null>(null);
  const [auditLogs, setAuditLogs] = useState<AuditEntry[]>([]);
  const [auditFilter, setAuditFilter] = useState("");

  const loadAudit = useCallback(async (filter = "") => {
    const path = filter ? `/auth/audit-logs?resource_type=${filter}` : "/auth/audit-logs";
    apiFetch<AuditEntry[]>(path).then(setAuditLogs).catch(() => {});
  }, []);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [u, s] = await Promise.all([
        apiFetch<UserRow[]>("/auth/users"),
        apiFetch<Stats>("/auth/system-stats"),
      ]);
      setUsers(u); setStats(s);
    } catch (e) { setError(String(e)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); loadAudit(); }, [load, loadAudit]);

  async function changeRole(userId: number, role: Role) {
    setRoleLoading(userId);
    try {
      const updated = await apiFetch<UserRow>(`/auth/users/${userId}/role`, {
        method: "PATCH",
        body: JSON.stringify({ role }),
      });
      setUsers(prev => prev.map(u => u.id === userId ? updated : u));
    } catch (e) {
      alert(String(e));
    } finally {
      setRoleLoading(null);
    }
  }

  async function deleteUser(userId: number) {
    try {
      await apiFetch(`/auth/users/${userId}`, { method: "DELETE" });
      setUsers(prev => prev.filter(u => u.id !== userId));
      setDeleteConfirm(null);
    } catch (e) {
      alert(String(e));
    }
  }

  return (
    <PageShell title="Admin Dashboard" subtitle="System overview and user management" maxWidth={1100}>
      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>

      {/* System stats */}
      {stats && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 12 }}>
          <StatCard label="Users"            value={stats.total_users} />
          <StatCard label="Establishments"   value={stats.total_establishments} sub={`${stats.active_establishments} active`} />
          <StatCard label="WCO Records"      value={stats.total_wco_records} />
          <StatCard label="Total WCO volume" value={`${stats.total_wco_liters.toLocaleString()} L`} sub="all time" />
        </div>
      )}

      {/* User table */}
      <div style={cardStyle}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 800, color: "#1a202c" }}>Users</div>
            <div style={{ fontSize: 12, color: "#a0aec0" }}>{users.length} registered account{users.length !== 1 ? "s" : ""}</div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => downloadCSV(users.map(u => ({ id: u.id, email: u.email, full_name: u.full_name, role: u.role, created_at: u.created_at })), "users.csv")} style={ghostBtnStyle}>Export CSV</button>
            <button onClick={() => setShowAdd(true)} style={primaryBtnStyle}>+ Add user</button>
          </div>
        </div>

        {error && (
          <div style={{ padding: "10px 14px", background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 10, fontSize: 13, color: "#dc2626", marginBottom: 16 }}>
            {error}
          </div>
        )}

        {loading ? (
          <div style={{ textAlign: "center", padding: "40px 0", color: "#a0aec0", fontSize: 13 }}>
            Loading…
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ background: "#f8fafc" }}>
                  {["#", "Name", "Email", "Role", "Joined", "Actions"].map(h => (
                    <th key={h} style={S.th}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {users.map((u, i) => {
                  const isSelf = u.id === me?.id;
                  const isDeleting = deleteConfirm === u.id;
                  return (
                    <tr key={u.id} style={{ background: isSelf ? "#f0fdf4" : i % 2 === 0 ? "white" : "#fafafa" }}>
                      <td style={S.td}>{u.id}</td>
                      <td style={{ ...S.td, fontWeight: 600, color: "#1a202c" }}>
                        {u.full_name}
                        {isSelf && <span style={{ marginLeft: 6, fontSize: 10, color: "#0f6e56", fontWeight: 700 }}>YOU</span>}
                      </td>
                      <td style={{ ...S.td, color: "#4a5568" }}>{u.email}</td>
                      <td style={S.td}>
                        {isSelf ? (
                          <RoleBadge role={u.role} />
                        ) : (
                          <select
                            value={u.role}
                            disabled={roleLoading === u.id}
                            onChange={e => changeRole(u.id, e.target.value as Role)}
                            style={{
                              fontSize: 12, fontWeight: 700, padding: "3px 8px",
                              borderRadius: 8, border: "1px solid #e2e8f0",
                              background: ROLE_STYLE[u.role]?.bg ?? "#f3f4f6",
                              color: ROLE_STYLE[u.role]?.color ?? "#374151",
                              cursor: roleLoading === u.id ? "wait" : "pointer",
                              outline: "none",
                            }}
                          >
                            <option value="viewer">Viewer</option>
                            <option value="researcher">Researcher</option>
                            <option value="admin">Admin</option>
                          </select>
                        )}
                      </td>
                      <td style={{ ...S.td, color: "#a0aec0" }}>
                        {new Date(u.created_at).toLocaleDateString("en-PH", { year: "numeric", month: "short", day: "numeric" })}
                      </td>
                      <td style={S.td}>
                        {!isSelf && (
                          isDeleting ? (
                            <div style={{ display: "flex", gap: 6 }}>
                              <button onClick={() => deleteUser(u.id)} style={{ ...S.dangerBtn, fontSize: 11 }}>Confirm</button>
                              <button onClick={() => setDeleteConfirm(null)} style={{ ...ghostBtnStyle, fontSize: 11 }}>Cancel</button>
                            </div>
                          ) : (
                            <button onClick={() => setDeleteConfirm(u.id)} style={ghostBtnStyle}>
                              Delete
                            </button>
                          )
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

      {/* ── LSTM Training ── */}
      <LSTMTrainingPanel />

      {/* Audit log */}
      <div style={cardStyle}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14, flexWrap: "wrap", gap: 8 }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 800, color: "#1a202c" }}>Audit Log</div>
            <div style={{ fontSize: 12, color: "#a0aec0" }}>Recent write operations across the system</div>
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {([
              { value: "",               label: "All" },
              { value: "establishment",  label: "Establishments" },
              { value: "wco_record",     label: "WCO Records" },
              { value: "quality_test",   label: "Quality Tests" },
              { value: "simulation_run", label: "Sim. Runs" },
              { value: "lstm_training",  label: "LSTM Training" },
              { value: "user",           label: "Users" },
            ]).map(({ value, label: lbl }) => (
              <button key={value} onClick={() => { setAuditFilter(value); loadAudit(value); }}
                style={{ fontSize: 11, padding: "4px 10px", borderRadius: 7, border: "1px solid #e2e8f0", cursor: "pointer", fontFamily: "inherit",
                  background: auditFilter === value ? "#0f6e56" : "white",
                  color: auditFilter === value ? "white" : "#64748b", fontWeight: 600 }}>
                {lbl}
              </button>
            ))}
            <button onClick={() => downloadCSV(auditLogs.map(a => ({ id: a.id, user: a.user_email, action: a.action, resource: a.resource_type, resource_id: a.resource_id ?? "", details: a.details ?? "", time: a.created_at })), "audit-log.csv")} style={{ ...ghostBtnStyle, fontSize: 11 }}>Export</button>
          </div>
        </div>
        {auditLogs.length === 0 ? (
          <div style={{ textAlign: "center", padding: "32px 0", color: "#a0aec0", fontSize: 13 }}>No audit entries yet.</div>
        ) : (
          <div style={{ overflowX: "auto", maxHeight: 340, overflowY: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead style={{ position: "sticky", top: 0, background: "#f8fafc", zIndex: 1 }}>
                <tr>
                  {["Timestamp", "User", "Action", "Resource Type", "Record ID", "Details"].map(h => (
                    <th key={h} style={{ padding: "8px 12px", textAlign: "left", fontSize: 10, fontWeight: 700, color: "#718096", textTransform: "uppercase", letterSpacing: "0.05em", borderBottom: "1px solid #e2e8f0", whiteSpace: "nowrap" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {auditLogs.map((a, i) => {
                  const actionColor: Record<string, string> = { create: "#065f46", update: "#1d4ed8", delete: "#dc2626" };
                  return (
                    <tr key={a.id} style={{ background: i % 2 === 0 ? "white" : "#fafafa" }}>
                      <td style={{ padding: "8px 12px", color: "#a0aec0", fontSize: 11, whiteSpace: "nowrap" }}>
                        {new Date(a.created_at).toLocaleString("en-PH", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                      </td>
                      <td style={{ padding: "8px 12px", fontSize: 12, color: "#4a5568" }}>{a.user_email}</td>
                      <td style={{ padding: "8px 12px" }}>
                        <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 99, background: (actionColor[a.action] ?? "#94a3b8") + "18", color: actionColor[a.action] ?? "#64748b", textTransform: "uppercase", letterSpacing: "0.05em" }}>{a.action}</span>
                      </td>
                      <td style={{ padding: "8px 12px", fontSize: 12, color: "#64748b" }}>
                        {{
                          establishment:  "Establishment",
                          wco_record:     "WCO Record",
                          quality_test:   "Quality Test",
                          simulation_run: "Simulation Run",
                          lstm_training:  "LSTM Training",
                          user:           "User",
                        }[a.resource_type] ?? a.resource_type}
                      </td>
                      <td style={{ padding: "8px 12px", fontSize: 12, color: "#94a3b8" }}>{a.resource_id ?? "—"}</td>
                      <td style={{ padding: "8px 12px", fontSize: 12, color: "#4a5568", maxWidth: 220 }}>
                        <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.details ?? "—"}</div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showAdd && (
        <AddUserModal onClose={() => setShowAdd(false)} onCreated={load} />
      )}

      </div>
    </PageShell>
  );
}

export default function AdminPage() {
  return (
    <ProtectedRoute require="admin">
      <div style={{ height: "100vh", display: "flex", flexDirection: "column", fontFamily: "system-ui, -apple-system, sans-serif" }}>
        <Navbar />
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
          <AdminDashboard />
        </div>
      </div>
    </ProtectedRoute>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const S: Record<string, React.CSSProperties> = {
  card: {
    background: "white", borderRadius: 16, padding: 20,
    boxShadow: "0 1px 3px rgba(0,0,0,0.04), 0 4px 16px rgba(0,0,0,0.05)",
    border: "1px solid rgba(0,0,0,0.06)",
  },
  statCard: {
    background: "white", borderRadius: 14, padding: "16px 20px",
    boxShadow: "0 1px 3px rgba(0,0,0,0.04), 0 4px 12px rgba(0,0,0,0.05)",
    border: "1px solid rgba(0,0,0,0.06)",
  },
  th: {
    padding: "10px 14px", textAlign: "left", fontSize: 11,
    fontWeight: 700, color: "#718096", letterSpacing: "0.05em",
    textTransform: "uppercase", borderBottom: "1px solid #e2e8f0",
    whiteSpace: "nowrap",
  },
  td: { padding: "11px 14px", borderBottom: "1px solid #f0f0f0", verticalAlign: "middle" },
  label: { display: "block", fontSize: 12, fontWeight: 700, color: "#374151", marginBottom: 5 },
  input: {
    width: "100%", padding: "9px 12px", borderRadius: 9,
    border: "1.5px solid #e2e8f0", fontSize: 13,
    outline: "none", boxSizing: "border-box",
  },
  primaryBtn: {
    padding: "8px 16px", borderRadius: 9, border: "none",
    background: "#0f6e56", color: "white",
    fontWeight: 700, fontSize: 13, cursor: "pointer",
  },
  dangerBtn: {
    padding: "5px 12px", borderRadius: 7, border: "none",
    background: "#fee2e2", color: "#dc2626",
    fontWeight: 700, cursor: "pointer",
  },
  ghostBtn: {
    padding: "5px 12px", borderRadius: 7,
    border: "1px solid #e2e8f0", background: "white",
    color: "#718096", fontWeight: 600, fontSize: 12, cursor: "pointer",
  },
  iconBtn: {
    background: "none", border: "none", fontSize: 16,
    color: "#a0aec0", cursor: "pointer", padding: "4px 6px",
  },
  modalOverlay: {
    position: "fixed", inset: 0,
    background: "rgba(0,0,0,0.4)", backdropFilter: "blur(4px)",
    display: "flex", alignItems: "center", justifyContent: "center",
    zIndex: 9999,
  },
  modal: {
    background: "white", borderRadius: 20, padding: 28, width: 420,
    boxShadow: "0 20px 60px rgba(0,0,0,0.2)",
  },
} as Record<string, React.CSSProperties>;
