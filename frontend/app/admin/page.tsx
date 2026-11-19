"use client";

import { useEffect, useState, useCallback } from "react";
import ProtectedRoute from "@/components/ProtectedRoute";
import Navbar from "@/components/Navbar";
import PageShell, { card as cardStyle, primaryBtn as primaryBtnStyle, ghostBtn as ghostBtnStyle, input as inputStyle, label as labelStyle } from "@/components/PageShell";
import { getToken } from "@/lib/api";
import { useAuth, type Role } from "@/lib/auth-context";
import { toast, Toaster } from "@/components/Toast";
import { downloadCSV } from "@/lib/csv";

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
      // Admin-only endpoint: public /auth/register can only create viewers.
      await apiFetch("/auth/users", {
        method: "POST",
        body: JSON.stringify({ email, full_name: name, password, role }),
      });
      toast("User created.");
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

type Metric = { n: number; mae: number | null; rmse: number | null; r2: number | null; mape: number | null };

interface Evaluation {
  mae: number; rmse: number; r2: number; mape: number;
  training_samples: number; val_samples: number; test_samples?: number; epochs_run: number;
  one_step?: { model: Metric; naive_last_week: Metric; seasonal_naive_13: Metric; moving_average_12: Metric };
  multi_step?: {
    horizon_weeks: number; origins: number; forecasts: number;
    model: Metric; naive_last_week: Metric; seasonal_naive_13: Metric; moving_average_12: Metric;
    aggregate_city_total?: { model: Metric; naive_last_week: Metric };
  };
}

interface Job {
  id: number; status: string; trigger: string; reason: string | null; change_count: number;
  requested_by: string | null; requested_at: string | null; last_change_at: string | null;
  started_at: string | null; finished_at: string | null; model_version: string | null;
  activated: boolean; dataset_records: number | null; dataset_establishments: number | null;
  error: string | null;
}

interface TrainingStatus {
  status: "idle" | "pending" | "training" | "completed" | "failed";
  metrics: Evaluation | null;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
  model_version: string | null;
  trained_at: string | null;
  active_model: { version: string; source: string; trained_at: string | null; data_cutoff_date?: string | null; note?: string } | null;
  current_job: Job | null;
  pending_job: Job | null;
  last_finished_job: Job | null;
  recent_jobs: Job[];
  auto_retraining: { enabled: boolean; debounce_seconds: number; mode: string; scheduler: string };
}

const fmtTime = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString("en-PH", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—";

const STATUS_STYLE: Record<string, { bg: string; border: string; color: string; label: string }> = {
  pending:   { bg: "#eff6ff", border: "#bfdbfe", color: "#1d4ed8", label: "Retraining scheduled" },
  training:  { bg: "#fffbeb", border: "#fde68a", color: "#92400e", label: "Training in progress…" },
  completed: { bg: "#f0fdf4", border: "#bbf7d0", color: "#065f46", label: "Training complete" },
  failed:    { bg: "#fef2f2", border: "#fca5a5", color: "#dc2626", label: "Training failed" },
};

function MetricRow({ label, m, highlight }: { label: string; m?: Metric; highlight?: boolean }) {
  if (!m) return null;
  const cell = (v: number | null, unit = "") => (v == null ? "—" : `${v}${unit}`);
  return (
    <tr style={{ fontWeight: highlight ? 800 : 500, color: highlight ? "#0f6e56" : "#475569" }}>
      <td style={{ padding: "4px 8px 4px 0" }}>{label}</td>
      <td style={{ padding: "4px 8px", textAlign: "right" }}>{cell(m.mae, " L")}</td>
      <td style={{ padding: "4px 8px", textAlign: "right" }}>{cell(m.rmse, " L")}</td>
      <td style={{ padding: "4px 8px", textAlign: "right" }}>{m.r2 == null ? "—" : m.r2.toFixed(3)}</td>
      <td style={{ padding: "4px 0 4px 8px", textAlign: "right" }}>{cell(m.mape, "%")}</td>
    </tr>
  );
}

function MetricTable({ title, note, rows }: { title: string; note: string; rows: [string, Metric | undefined, boolean?][] }) {
  return (
    <div style={{ background: "#f8fafc", borderRadius: 10, padding: "10px 14px", border: "1px solid #e2e8f0" }}>
      <div style={{ fontSize: 11, fontWeight: 800, color: "#1a202c", marginBottom: 2 }}>{title}</div>
      <div style={{ fontSize: 10.5, color: "#94a3b8", marginBottom: 6 }}>{note}</div>
      <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse", fontVariantNumeric: "tabular-nums" }}>
        <thead>
          <tr style={{ fontSize: 10, color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.05em" }}>
            <th style={{ textAlign: "left", fontWeight: 700 }}>Method</th>
            <th style={{ textAlign: "right", fontWeight: 700 }}>MAE</th>
            <th style={{ textAlign: "right", fontWeight: 700 }}>RMSE</th>
            <th style={{ textAlign: "right", fontWeight: 700 }}>R²</th>
            <th style={{ textAlign: "right", fontWeight: 700 }}>MAPE</th>
          </tr>
        </thead>
        <tbody>{rows.map(([label, m, hi]) => <MetricRow key={label} label={label} m={m} highlight={hi} />)}</tbody>
      </table>
    </div>
  );
}

function LSTMTrainingPanel() {
  const [state,    setState]    = useState<TrainingStatus | null>(null);
  const [starting, setStarting] = useState(false);
  const [now,      setNow]      = useState(Date.now());

  const fetchStatus = useCallback(async () => {
    try { setState(await apiFetch<TrainingStatus>("/forecast/training-status")); }
    catch { /* keep last known state */ }
  }, []);

  // Poll quickly while a job is pending/training, slowly otherwise, so automatic
  // retraining triggered from other pages (or other users) shows up here too.
  const active = state?.status === "pending" || state?.status === "training";
  useEffect(() => {
    fetchStatus();
    const id = setInterval(fetchStatus, active ? 2000 : 10000);
    return () => clearInterval(id);
  }, [fetchStatus, active]);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);

  async function startTraining() {
    setStarting(true);
    try {
      await apiFetch("/forecast/train", { method: "POST" });
      toast("Retraining started.", "info");
      await fetchStatus();
    } catch (e) { toast(String(e).replace("Error: ", ""), "error"); }
    finally { setStarting(false); }
  }

  const s = state;
  const isBusy = s?.status === "training";
  const ev = s?.metrics ?? null;
  const st = s ? STATUS_STYLE[s.status] : undefined;
  const pendingIn = s?.pending_job?.last_change_at && s.auto_retraining
    ? Math.max(0, Math.ceil(s.auto_retraining.debounce_seconds - (now - new Date(s.pending_job.last_change_at).getTime()) / 1000))
    : null;

  return (
    <div style={cardStyle}>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 800, color: "#1a202c" }}>LSTM Forecast Model</div>
          <div style={{ fontSize: 12, color: "#a0aec0" }}>
            {s?.auto_retraining?.enabled
              ? `Automatic batch retraining is ON — data changes are coalesced for ${s.auto_retraining.debounce_seconds}s, then the model is retrained from scratch (not online learning).`
              : "Automatic retraining is OFF — use Retrain to update the model."}
          </div>
        </div>
        <button
          onClick={startTraining}
          disabled={starting || isBusy}
          style={{ ...primaryBtnStyle, opacity: (starting || isBusy) ? 0.65 : 1, display: "flex", alignItems: "center", gap: 8 }}
        >
          {isBusy && (
            <span style={{ width: 14, height: 14, border: "2px solid rgba(255,255,255,0.4)", borderTopColor: "white", borderRadius: "50%", animation: "spin 0.8s linear infinite", display: "inline-block" }} />
          )}
          {isBusy ? "Training…" : starting ? "Starting…" : "Retrain now"}
        </button>
      </div>

      {/* Status strip */}
      {s && st && (
        <div style={{
          padding: "10px 14px", borderRadius: 10, marginBottom: 12,
          background: st.bg, border: `1px solid ${st.border}`, fontSize: 12, color: st.color,
          display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
        }}>
          <span style={{ fontWeight: 700 }}>{st.label}</span>
          {s.status === "pending" && s.pending_job && (
            <span>
              — {s.pending_job.change_count} change{s.pending_job.change_count !== 1 ? "s" : ""} ({s.pending_job.reason})
              {s.pending_job.trigger === "manual" ? ", starting now" : pendingIn != null ? `, starts in ~${pendingIn}s unless more changes arrive` : ""}
            </span>
          )}
          {s.status === "training" && s.current_job && <span>— job #{s.current_job.id} started {fmtTime(s.current_job.started_at)}</span>}
          {s.status === "completed" && s.last_finished_job && <span>— {s.last_finished_job.model_version} activated</span>}
          {s.status === "failed" && (
            <span>— {s.error}{s.model_version ? ` · previous model ${s.model_version} is still active` : ""}</span>
          )}
          {s.finished_at && !active && <span style={{ marginLeft: "auto", color: "#94a3b8" }}>{fmtTime(s.finished_at)}</span>}
        </div>
      )}

      {/* Active model */}
      {s?.active_model ? (
        <div style={{ fontSize: 12, color: "#475569", marginBottom: 12, lineHeight: 1.6 }}>
          <strong>Active model:</strong> {s.active_model.version}
          {s.active_model.trained_at && <> · trained {fmtTime(s.active_model.trained_at)}</>}
          {s.active_model.data_cutoff_date && <> · data through {s.active_model.data_cutoff_date}</>}
          {s.active_model.note && <div style={{ color: "#b45309" }}>{s.active_model.note}</div>}
        </div>
      ) : s && (
        <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 12 }}>No trained model yet. Click &quot;Retrain now&quot;.</div>
      )}

      {/* Evaluation */}
      {ev && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 10, marginBottom: 12 }}>
          <MetricTable
            title="1-week-ahead, held-out test weeks"
            note={`${ev.test_samples ?? "?"} establishment-weeks never seen in training · errors in liters per establishment-week`}
            rows={[
              ["LSTM", ev.one_step?.model ?? { n: 0, mae: ev.mae, rmse: ev.rmse, r2: ev.r2, mape: ev.mape }, true],
              ["Naive (last week)", ev.one_step?.naive_last_week],
              ["Seasonal naive (t−13)", ev.one_step?.seasonal_naive_13],
              ["12-week moving average", ev.one_step?.moving_average_12],
            ]}
          />
          {ev.multi_step?.model && (
            <MetricTable
              title={`${ev.multi_step.horizon_weeks}-week recursive backtest (rolling origin)`}
              note={`${ev.multi_step.origins} forecast origins × ${ev.multi_step.forecasts / Math.max(1, ev.multi_step.origins)} establishments · all target weeks held out`}
              rows={[
                ["LSTM", ev.multi_step.model, true],
                ["Naive (last week)", ev.multi_step.naive_last_week],
                ["Seasonal naive (t−13)", ev.multi_step.seasonal_naive_13],
                ["12-week moving average", ev.multi_step.moving_average_12],
              ]}
            />
          )}
        </div>
      )}
      {ev && (
        <div style={{ fontSize: 11, color: "#94a3b8", marginBottom: 12 }}>
          Train / validation / test windows: {ev.training_samples} / {ev.val_samples} / {ev.test_samples ?? "—"} · {ev.epochs_run} epochs (early stopping).
          Metrics describe performance on the current dataset; with synthetic data they do not establish real-world accuracy.
        </div>
      )}

      {/* Recent jobs */}
      {s && s.recent_jobs.length > 0 && (
        <div>
          <div style={{ fontSize: 10, fontWeight: 800, color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 6 }}>Recent retraining jobs</div>
          <table style={{ width: "100%", fontSize: 11.5, borderCollapse: "collapse" }}>
            <tbody>
              {s.recent_jobs.map(j => (
                <tr key={j.id} style={{ borderTop: "1px solid #f1f5f9", color: "#475569" }}>
                  <td style={{ padding: "5px 6px 5px 0", fontWeight: 700 }}>#{j.id}</td>
                  <td style={{ padding: "5px 6px" }}>
                    <span style={{ fontWeight: 700, color: STATUS_STYLE[j.status]?.color ?? "#64748b" }}>{j.status}</span>
                  </td>
                  <td style={{ padding: "5px 6px" }}>{j.trigger}{j.change_count > 1 ? ` · ${j.change_count} changes` : ""}</td>
                  <td style={{ padding: "5px 6px", color: "#94a3b8" }}>{j.reason}</td>
                  <td style={{ padding: "5px 6px" }}>{fmtTime(j.finished_at ?? j.started_at ?? j.requested_at)}</td>
                  <td style={{ padding: "5px 0 5px 6px", color: "#94a3b8", maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                      title={j.error ?? j.model_version ?? ""}>
                    {j.model_version ?? (j.error ? j.error.slice(0, 60) : "")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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
  const [detailsEntry, setDetailsEntry] = useState<AuditEntry | null>(null);

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
      toast(`Role updated to ${role}.`, "info");
    } catch (e) {
      toast(String(e).replace("Error: ", ""), "error");
    } finally {
      setRoleLoading(null);
    }
  }

  async function deleteUser(userId: number) {
    try {
      await apiFetch(`/auth/users/${userId}`, { method: "DELETE" });
      setUsers(prev => prev.filter(u => u.id !== userId));
      setDeleteConfirm(null);
      toast("User deleted.", "info");
    } catch (e) {
      toast(String(e).replace("Error: ", ""), "error");
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
                        {a.details && a.details.length > 55 ? (
                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{a.details}</div>
                            <button
                              onClick={() => setDetailsEntry(a)}
                              style={{ fontSize: 10, padding: "2px 8px", borderRadius: 6, border: "1px solid #e2e8f0", background: "white", cursor: "pointer", color: "#374151", whiteSpace: "nowrap", fontFamily: "inherit", flexShrink: 0, fontWeight: 600 }}
                            >
                              View
                            </button>
                          </div>
                        ) : (
                          <div>{a.details ?? "—"}</div>
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

      {showAdd && (
        <AddUserModal onClose={() => setShowAdd(false)} onCreated={load} />
      )}

      {detailsEntry && (
        <div style={S.modalOverlay} onClick={() => setDetailsEntry(null)}>
          <div style={{ ...S.modal, width: 480 }} onClick={e => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
              <div>
                <div style={{ fontSize: 15, fontWeight: 800, color: "#1a202c" }}>Audit Entry #{detailsEntry.id}</div>
                <div style={{ fontSize: 11, color: "#a0aec0", marginTop: 2 }}>
                  {new Date(detailsEntry.created_at).toLocaleString("en-PH", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                </div>
              </div>
              <button onClick={() => setDetailsEntry(null)} style={S.iconBtn}>✕</button>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10, fontSize: 13 }}>
              {[
                { label: "User",     value: detailsEntry.user_email },
                { label: "Action",   value: detailsEntry.action },
                { label: "Resource", value: `${{ establishment: "Establishment", wco_record: "WCO Record", quality_test: "Quality Test", simulation_run: "Simulation Run", lstm_training: "LSTM Training", user: "User" }[detailsEntry.resource_type] ?? detailsEntry.resource_type}${detailsEntry.resource_id != null ? ` #${detailsEntry.resource_id}` : ""}` },
              ].map(({ label, value }) => (
                <div key={label} style={{ display: "flex", gap: 12 }}>
                  <span style={{ width: 72, flexShrink: 0, color: "#a0aec0", fontWeight: 600 }}>{label}</span>
                  <span style={{ color: "#1a202c" }}>{value}</span>
                </div>
              ))}
              <div>
                <div style={{ color: "#a0aec0", fontWeight: 600, marginBottom: 6 }}>Details</div>
                <div style={{ background: "#f8fafc", borderRadius: 10, padding: "12px 14px", fontSize: 12, color: "#374151", wordBreak: "break-word", whiteSpace: "pre-wrap", maxHeight: 220, overflowY: "auto", border: "1px solid #e2e8f0", lineHeight: 1.6 }}>
                  {detailsEntry.details ?? "—"}
                </div>
              </div>
            </div>
          </div>
        </div>
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
      <Toaster />
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
