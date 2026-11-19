"use client";

import { useState, type CSSProperties } from "react";
import { API_BASE, getToken, setToken } from "@/lib/api";
import { popup, greenGradient } from "@/lib/theme";
import PasswordInput from "@/components/auth/PasswordInput";

/** Any signed-in user changes their own password (current password required). */
export default function ChangePasswordModal({ onClose }: { onClose: () => void }) {
  const [current, setCurrent] = useState("");
  const [next,    setNext]    = useState("");
  const [confirm, setConfirm] = useState("");
  const [error,   setError]   = useState<string | null>(null);
  const [done,    setDone]    = useState(false);
  const [busy,    setBusy]    = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (next.length < 8)    { setError("The new password must be at least 8 characters."); return; }
    if (next !== confirm)   { setError("The new passwords do not match."); return; }
    if (next === current)   { setError("The new password must be different from the current one."); return; }
    setBusy(true);
    try {
      const res = await fetch(`${API_BASE}/auth/me/password`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${getToken()}` },
        body: JSON.stringify({ current_password: current, new_password: next }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const detail = typeof data.detail === "string" ? data.detail : null;
        throw new Error(detail ?? `Could not change the password (${res.status}).`);
      }
      // The old token stops working once the password changes; keep this session signed in.
      if (data.access_token) setToken(data.access_token);
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not change the password.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={S.overlay} onClick={onClose}>
      <div className="wco-modal" style={S.modal} onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="cp-title">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 4 }}>
          <h2 id="cp-title" style={S.title}>Change password</h2>
          <button onClick={onClose} aria-label="Close" style={S.close}>✕</button>
        </div>

        {done ? (
          <>
            <p style={S.text}>Your password was updated. Any other devices signed in to this account have been signed out.</p>
            <button onClick={onClose} style={S.primary}>Done</button>
          </>
        ) : (
          <form onSubmit={submit}>
            <p style={S.text}>Other devices signed in to this account will be signed out.</p>
            <label style={S.label}>Current password</label>
            <PasswordInput style={S.input} value={current} onChange={e => setCurrent(e.target.value)}
              autoComplete="current-password" required autoFocus />
            <label style={{ ...S.label, marginTop: 12 }}>New password</label>
            <PasswordInput style={S.input} value={next} onChange={e => setNext(e.target.value)}
              autoComplete="new-password" placeholder="At least 8 characters" required minLength={8} />
            <label style={{ ...S.label, marginTop: 12 }}>Confirm new password</label>
            <PasswordInput style={S.input} value={confirm} onChange={e => setConfirm(e.target.value)}
              autoComplete="new-password" required />
            {error && <div style={S.error}>{error}</div>}
            <button type="submit" disabled={busy} style={{ ...S.primary, opacity: busy ? 0.7 : 1 }}>
              {busy ? "Saving…" : "Change password"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

const S: Record<string, CSSProperties> = {
  overlay: {
    position: "fixed", inset: 0, zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center",
    padding: 16, background: "rgba(6,40,30,0.35)", backdropFilter: "blur(4px)", WebkitBackdropFilter: "blur(4px)",
  },
  modal: { ...popup, borderRadius: 22, padding: 26, width: 400, maxWidth: "calc(100vw - 24px)", fontFamily: "system-ui, -apple-system, sans-serif" },
  title: { fontSize: 18, fontWeight: 900, color: "#0b3d30", margin: 0 },
  close: { background: "none", border: "none", fontSize: 18, cursor: "pointer", color: "#94a3b8", padding: "2px 6px" },
  text: { fontSize: 12.5, color: "#5b7a71", margin: "4px 0 16px", lineHeight: 1.5 },
  label: { display: "block", fontSize: 11, fontWeight: 700, color: "#3b5f55", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 },
  input: {
    width: "100%", padding: "10px 12px", borderRadius: 10, border: "1.5px solid #dbe7e2", fontSize: 14,
    outline: "none", boxSizing: "border-box", color: "#1a202c", fontFamily: "inherit", background: "white",
  },
  error: { marginTop: 12, padding: "9px 12px", borderRadius: 10, background: "#fef2f2", border: "1px solid #fecaca", color: "#b91c1c", fontSize: 12.5 },
  primary: {
    marginTop: 18, width: "100%", padding: "11px 14px", borderRadius: 11, border: "none", cursor: "pointer",
    background: greenGradient, color: "white", fontWeight: 800, fontSize: 14, fontFamily: "inherit",
    boxShadow: "0 6px 16px rgba(15,110,86,0.25)",
  },
};
