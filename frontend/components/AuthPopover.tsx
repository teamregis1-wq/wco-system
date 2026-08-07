"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000/api/v1";

type Tab = "signin" | "register";

interface Props {
  open: boolean;
  onClose: () => void;
}

/**
 * Login / sign-up popover anchored below the landing page's Sign In button.
 * Render inside a `position: relative` container — the card positions itself
 * at top-right with an arrow pointing up at the trigger.
 */
export default function AuthPopover({ open, onClose }: Props) {
  const [tab, setTab] = useState<Tab>("signin");
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <>
      {/* Click-outside catcher */}
      <div style={P.backdrop} onClick={onClose} />

      <div className="wco-auth-pop" style={P.card} role="dialog" aria-label="Sign in or create an account">
        <style>{`
          @keyframes wco-pop-in {
            from { opacity: 0; transform: translateY(-10px) scale(0.96); }
            to   { opacity: 1; transform: translateY(0) scale(1); }
          }
          .wco-auth-pop { animation: wco-pop-in 0.24s cubic-bezier(0.16, 1, 0.3, 1); transform-origin: top right; }
        `}</style>
        <div style={P.arrow} />

        {/* Tab switcher */}
        <div style={P.tabs}>
          <button
            onClick={() => { setTab("signin"); setNotice(null); }}
            style={{ ...P.tabBtn, ...(tab === "signin" ? P.tabActive : P.tabInactive) }}
          >
            Sign In
          </button>
          <button
            onClick={() => { setTab("register"); setNotice(null); }}
            style={{ ...P.tabBtn, ...(tab === "register" ? P.tabActive : P.tabInactive) }}
          >
            Create Account
          </button>
        </div>

        {notice && <div style={P.noticeBox}>{notice}</div>}

        {tab === "signin"
          ? <SignInForm />
          : <RegisterForm onRegistered={() => { setTab("signin"); setNotice("Account created — sign in below."); }} />
        }
      </div>
    </>
  );
}

// ── Sign In ───────────────────────────────────────────────────────────────────

function SignInForm() {
  const { signIn } = useAuth();
  const router = useRouter();
  const [email,    setEmail]    = useState("");
  const [password, setPassword] = useState("");
  const [error,    setError]    = useState<string | null>(null);
  const [busy,     setBusy]     = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await signIn(email, password);
      router.push("/map");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed.");
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <label style={P.label}>Email address</label>
      <input style={P.input} type="email" value={email}
        onChange={e => setEmail(e.target.value)}
        placeholder="you@example.com" autoComplete="email" required autoFocus />

      <label style={{ ...P.label, marginTop: 12 }}>Password</label>
      <input style={P.input} type="password" value={password}
        onChange={e => setPassword(e.target.value)}
        placeholder="••••••••" autoComplete="current-password" required />

      {error && <div style={P.errorBox}>{error}</div>}

      <button type="submit" disabled={busy} style={{ ...P.primaryBtn, opacity: busy ? 0.7 : 1 }}>
        {busy ? "Signing in…" : "Sign In"}
      </button>

      {/* Dev hint — remove before production hand-off */}
      <div style={P.hintBox}>
        <div style={P.hintTitle}>Test accounts</div>
        {[
          { role: "Admin",      email: "admin@wco.local",      pw: "admin12345",    color: "#92400e", bg: "#fef3c7" },
          { role: "Researcher", email: "researcher@wco.local", pw: "research12345", color: "#1d4ed8", bg: "#dbeafe" },
        ].map(a => (
          <button key={a.email} type="button"
            onClick={() => { setEmail(a.email); setPassword(a.pw); setError(null); }}
            style={P.hintRow}>
            <span style={{ ...P.hintBadge, background: a.bg, color: a.color }}>{a.role}</span>
            <span style={P.hintEmail}>{a.email}</span>
          </button>
        ))}
      </div>
    </form>
  );
}

// ── Register ──────────────────────────────────────────────────────────────────

function RegisterForm({ onRegistered }: { onRegistered: () => void }) {
  const [fullName, setFullName] = useState("");
  const [email,    setEmail]    = useState("");
  const [password, setPassword] = useState("");
  const [confirm,  setConfirm]  = useState("");
  const [error,    setError]    = useState<string | null>(null);
  const [busy,     setBusy]     = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password !== confirm)   { setError("Passwords do not match."); return; }
    if (password.length < 8)    { setError("Password must be at least 8 characters."); return; }

    setBusy(true);
    try {
      const res = await fetch(`${API_BASE}/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, full_name: fullName, password, role: "viewer" }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.detail ?? "Registration failed.");
      }
      onRegistered();
    } catch (err) {
      setError(String(err).replace("Error: ", ""));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <label style={P.label}>Full name</label>
      <input style={P.input} value={fullName}
        onChange={e => setFullName(e.target.value)}
        placeholder="e.g. Maria Santos" required autoFocus />

      <label style={{ ...P.label, marginTop: 12 }}>Email address</label>
      <input style={P.input} type="email" value={email}
        onChange={e => setEmail(e.target.value)}
        placeholder="you@example.com" autoComplete="email" required />

      <label style={{ ...P.label, marginTop: 12 }}>Password</label>
      <input style={P.input} type="password" value={password}
        onChange={e => setPassword(e.target.value)}
        placeholder="Min. 8 characters" autoComplete="new-password" required />

      <label style={{ ...P.label, marginTop: 12 }}>Confirm password</label>
      <input style={P.input} type="password" value={confirm}
        onChange={e => setConfirm(e.target.value)}
        placeholder="Repeat password" autoComplete="new-password" required />

      <div style={P.roleNote}>
        Your account will have <strong>Viewer</strong> access. An admin can upgrade your role later.
      </div>

      {error && <div style={P.errorBox}>{error}</div>}

      <button type="submit" disabled={busy} style={{ ...P.primaryBtn, opacity: busy ? 0.7 : 1 }}>
        {busy ? "Creating account…" : "Create Account"}
      </button>
    </form>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const P: Record<string, React.CSSProperties> = {
  backdrop: { position: "fixed", inset: 0, zIndex: 900, background: "transparent" },
  card: {
    position: "absolute", top: "calc(100% + 14px)", right: 0, zIndex: 901,
    width: 340, background: "white", borderRadius: 16, padding: "18px 20px 20px",
    boxShadow: "0 8px 20px rgba(0,0,0,0.18), 0 24px 60px rgba(0,0,0,0.28)",
    color: "#1a202c", textAlign: "left",
  },
  arrow: {
    position: "absolute", top: -7, right: 28, width: 14, height: 14,
    background: "white", transform: "rotate(45deg)",
    borderRadius: 2, boxShadow: "-2px -2px 4px rgba(0,0,0,0.05)",
  },
  tabs: {
    display: "flex", background: "#f1f5f9",
    borderRadius: 10, padding: 3, marginBottom: 16, gap: 3,
  },
  tabBtn: {
    flex: 1, padding: "8px 0", borderRadius: 8, border: "none",
    fontSize: 12.5, fontWeight: 700, cursor: "pointer",
    transition: "all 0.18s ease", fontFamily: "inherit",
  },
  tabActive:   { background: "white", color: "#0f6e56", boxShadow: "0 2px 8px rgba(0,0,0,0.08)" },
  tabInactive: { background: "transparent", color: "#94a3b8" },
  noticeBox: {
    marginBottom: 12, padding: "9px 12px",
    background: "#f0fdf4", border: "1px solid #bbf7d0",
    borderRadius: 10, fontSize: 12.5, color: "#166534",
  },
  label: { display: "block", fontSize: 11.5, fontWeight: 700, color: "#374151", marginBottom: 4, letterSpacing: "0.02em" },
  input: {
    width: "100%", padding: "9px 12px", borderRadius: 9,
    border: "1.5px solid #e2e8f0", fontSize: 13.5, outline: "none",
    boxSizing: "border-box", color: "#1a202c", fontFamily: "inherit",
  },
  errorBox: {
    marginTop: 10, padding: "9px 12px",
    background: "#fef2f2", border: "1px solid #fca5a5",
    borderRadius: 10, fontSize: 12.5, color: "#dc2626",
  },
  primaryBtn: {
    marginTop: 14, width: "100%", padding: 11,
    borderRadius: 10, border: "none",
    background: "linear-gradient(135deg,#0f6e56,#0a5240)",
    color: "white", fontWeight: 700, fontSize: 13.5, cursor: "pointer",
    boxShadow: "0 4px 12px rgba(15,110,86,0.3)", fontFamily: "inherit",
  },
  roleNote: {
    marginTop: 12, padding: "9px 11px",
    background: "#f0fdf4", border: "1px solid #bbf7d0",
    borderRadius: 9, fontSize: 11.5, color: "#166534", lineHeight: 1.5,
  },
  // Dev hints
  hintBox: {
    marginTop: 14, padding: 11, background: "#f8fafc",
    borderRadius: 10, border: "1px solid #e2e8f0",
  },
  hintTitle: {
    fontSize: 9.5, fontWeight: 700, color: "#94a3b8",
    letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 6,
  },
  hintRow: {
    display: "flex", alignItems: "center", gap: 8, width: "100%",
    padding: "4px 7px", borderRadius: 7, border: "none",
    background: "transparent", cursor: "pointer",
    textAlign: "left", marginBottom: 2, fontFamily: "inherit",
  },
  hintBadge: {
    fontSize: 9.5, fontWeight: 700, padding: "2px 7px", borderRadius: 99,
    textTransform: "uppercase", letterSpacing: "0.05em", flexShrink: 0,
  },
  hintEmail: { fontSize: 11.5, color: "#4a5568" },
};
