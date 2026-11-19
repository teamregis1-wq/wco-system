"use client";

/**
 * Compact live indicator of the forecast model's retraining state.
 *
 * Bump `refreshKey` after a data change; the badge re-fetches
 * /forecast/training-status and keeps polling while a job is pending or
 * training, then stops. Shows nothing until there is something to report.
 */
import { useEffect, useState } from "react";
import { API_BASE, getToken } from "@/lib/api";

const BASE = API_BASE;

interface Status {
  status: "idle" | "pending" | "training" | "completed" | "failed";
  model_version: string | null;
  error: string | null;
  pending_job: { change_count: number; last_change_at: string | null } | null;
  auto_retraining?: { enabled: boolean; debounce_seconds: number; executor?: string;
                      worker?: { online: boolean } | null };
}

const LOOK: Record<string, { bg: string; fg: string; text: (s: Status) => string }> = {
  pending:   { bg: "#eff6ff", fg: "#1d4ed8", text: s => `Forecast model retraining scheduled (${s.pending_job?.change_count ?? 1} change${(s.pending_job?.change_count ?? 1) !== 1 ? "s" : ""} queued)…`
               + (s.auto_retraining?.executor === "worker" && !s.auto_retraining?.worker?.online
                  ? " Waiting for the retraining worker to come online." : "") },
  training:  { bg: "#fffbeb", fg: "#92400e", text: () => "Retraining the forecast model on the updated data…" },
  completed: { bg: "#f0fdf4", fg: "#065f46", text: s => `Forecast model updated — ${s.model_version ?? "new version"} is active.` },
  failed:    { bg: "#fef2f2", fg: "#dc2626", text: s => `Retraining failed; previous model ${s.model_version ?? ""} kept. ${s.error ?? ""}` },
};

export default function RetrainStatusBadge({ refreshKey }: { refreshKey: number }) {
  const [s, setS] = useState<Status | null>(null);

  useEffect(() => {
    if (refreshKey === 0) return;           // nothing changed yet in this view
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      try {
        const res = await fetch(`${BASE}/forecast/training-status`, {
          headers: { Authorization: `Bearer ${getToken()}` },
        });
        if (!res.ok) return;
        const data: Status = await res.json();
        if (cancelled) return;
        setS(data);
        if (data.status === "pending" || data.status === "training") timer = setTimeout(tick, 2000);
      } catch { /* transient; the admin panel shows full status */ }
    };
    tick();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [refreshKey]);

  if (!s || refreshKey === 0) return null;
  if (s.auto_retraining && !s.auto_retraining.enabled) return null;
  const look = LOOK[s.status];
  if (!look) return null;
  return (
    <div style={{ marginBottom: 12, padding: "7px 12px", borderRadius: 8, fontSize: 12, fontWeight: 600,
                  background: look.bg, color: look.fg, border: `1px solid ${look.fg}22` }}>
      {look.text(s)}
    </div>
  );
}
