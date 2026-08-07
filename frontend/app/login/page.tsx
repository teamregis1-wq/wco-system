"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/lib/auth-context";
import { LogoWordmark } from "@/components/Logo";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000/api/v1";

type Tab = "signin" | "register";

export default function LoginPage() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("signin");

  useEffect(() => {
    if (!loading && user) router.replace("/map");
  }, [user, loading, router]);

  if (loading || user) return <Spinner />;

  return (
    <main style={S.page}>
      {/* ── Left branding panel ── */}
      <div style={S.left}>
        <div style={S.leftInner}>
          <Link href="/" style={{ textDecoration: "none", display: "inline-block", marginBottom: 26 }}>
            <LogoWordmark size={44} color="white" subtitleColor="rgba(255,255,255,0.55)" />
          </Link>
          <h1 style={S.headline}>Every litre mapped, forecast, and collected.</h1>
          <p style={S.sub}>
            Waste cooking oil generation forecasting, GIS hotspot analysis,
            and road-accurate collection routing for Batangas City.
          </p>
          <div style={S.featureList}>
            {[
              "Getis-Ord Gi* spatial hotspot analysis",
              "Volume-weighted KDE density heatmap",
              "3-month LSTM generation forecast",
              "Road-network route optimization",
            ].map(f => (
              <div key={f} style={S.feature}>
                <span style={S.featureDot} />
                {f}
              </div>
            ))}
          </div>
          <div style={S.accessNote}>
            Access is limited to authorized members. New accounts start as viewers until an administrator assigns a role.
          </div>
        </div>
      </div>

      {/* ── Right form panel ── */}
      <div style={S.right}>
        <div style={S.card}>
          {/* Tab switcher */}
          <div style={S.tabs}>
            <button
              onClick={() => setTab("signin")}
              style={{ ...S.tabBtn, ...(tab === "signin" ? S.tabActive : S.tabInactive) }}
            >
              Sign In
            </button>
            <button
              onClick={() => setTab("register")}
              style={{ ...S.tabBtn, ...(tab === "register" ? S.tabActive : S.tabInactive) }}
            >
              Create Account
            </button>
          </div>

          {tab === "signin"
            ? <SignInForm onSuccess={() => router.push("/map")} onSwitchTab={() => setTab("register")} />
            : <RegisterForm onSuccess={() => setTab("signin")} onSwitchTab={() => setTab("signin")} />
          }
        </div>
      </div>
    </main>
  );
}

// ── Sign In form ──────────────────────────────────────────────────────────────

function SignInForm({ onSuccess, onSwitchTab }: { onSuccess: () => void; onSwitchTab: () => void }) {
  const { signIn } = useAuth();
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
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div style={S.formHeader}>
        <h2 style={S.formTitle}>Welcome back</h2>
        <p style={S.formSub}>Sign in to your WCO Atlas account</p>
      </div>

      <form onSubmit={submit}>
        <label style={S.label}>Email address</label>
        <input style={S.input} type="email" value={email}
          onChange={e => setEmail(e.target.value)}
          placeholder="you@example.com" autoComplete="email" required />

        <label style={{ ...S.label, marginTop: 14 }}>Password</label>
        <input style={S.input} type="password" value={password}
          onChange={e => setPassword(e.target.value)}
          placeholder="••••••••" autoComplete="current-password" required />

        {error && <div style={S.errorBox}>{error}</div>}

        <button type="submit" disabled={busy} style={{ ...S.primaryBtn, opacity: busy ? 0.7 : 1 }}>
          {busy ? "Signing in…" : "Sign In"}
        </button>
      </form>

      <p style={S.switchText}>
        Don't have an account?{" "}
        <button onClick={onSwitchTab} style={S.switchLink}>Request access</button>
      </p>

      {/* Dev hint — remove before production hand-off */}
      <div style={S.hintBox}>
        <div style={S.hintTitle}>Test accounts</div>
        {[
          { role: "Admin",      email: "admin@wco.local",      pw: "admin12345",    color: "#92400e", bg: "#fef3c7" },
          { role: "Researcher", email: "researcher@wco.local", pw: "research12345", color: "#1d4ed8", bg: "#dbeafe" },
        ].map(a => (
          <button key={a.email} onClick={() => { setEmail(a.email); setPassword(a.pw); setError(null); }} style={S.hintRow}>
            <span style={{ ...S.hintBadge, background: a.bg, color: a.color }}>{a.role}</span>
            <span style={S.hintEmail}>{a.email}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Register form ─────────────────────────────────────────────────────────────

function RegisterForm({ onSuccess, onSwitchTab }: { onSuccess: () => void; onSwitchTab: () => void }) {
  const [fullName,  setFullName]  = useState("");
  const [email,     setEmail]     = useState("");
  const [password,  setPassword]  = useState("");
  const [confirm,   setConfirm]   = useState("");
  const [error,     setError]     = useState<string | null>(null);
  const [success,   setSuccess]   = useState(false);
  const [busy,      setBusy]      = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }

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
      setSuccess(true);
      setTimeout(onSuccess, 2200);
    } catch (err) {
      setError(String(err).replace("Error: ", ""));
    } finally {
      setBusy(false);
    }
  }

  if (success) {
    return (
      <div style={{ textAlign: "center", padding: "48px 0" }}>
        <div style={{ fontSize: 40, marginBottom: 16 }}>✅</div>
        <h3 style={{ fontSize: 18, fontWeight: 800, color: "#111827", margin: "0 0 8px" }}>Account created!</h3>
        <p style={{ fontSize: 13, color: "#6b7280" }}>Redirecting you to sign in…</p>
      </div>
    );
  }

  return (
    <div>
      <div style={S.formHeader}>
        <h2 style={S.formTitle}>Create your account</h2>
        <p style={S.formSub}>New accounts start with viewer access</p>
      </div>

      <form onSubmit={submit}>
        <label style={S.label}>Full name</label>
        <input style={S.input} value={fullName}
          onChange={e => setFullName(e.target.value)}
          placeholder="e.g. Maria Santos" required />

        <label style={{ ...S.label, marginTop: 14 }}>Email address</label>
        <input style={S.input} type="email" value={email}
          onChange={e => setEmail(e.target.value)}
          placeholder="you@example.com" autoComplete="email" required />

        <label style={{ ...S.label, marginTop: 14 }}>Password</label>
        <input style={S.input} type="password" value={password}
          onChange={e => setPassword(e.target.value)}
          placeholder="Min. 8 characters" autoComplete="new-password" required />

        <label style={{ ...S.label, marginTop: 14 }}>Confirm password</label>
        <input style={S.input} type="password" value={confirm}
          onChange={e => setConfirm(e.target.value)}
          placeholder="Repeat password" autoComplete="new-password" required />

        {/* Role note */}
        <div style={S.roleNote}>
          Your account will have <strong>Viewer</strong> access. An admin can upgrade your role later.
        </div>

        {error && <div style={S.errorBox}>{error}</div>}

        <button type="submit" disabled={busy} style={{ ...S.primaryBtn, opacity: busy ? 0.7 : 1 }}>
          {busy ? "Creating account…" : "Create Account"}
        </button>
      </form>

      <p style={S.switchText}>
        Already have an account?{" "}
        <button onClick={onSwitchTab} style={S.switchLink}>Sign in</button>
      </p>
    </div>
  );
}

// ── Spinner ───────────────────────────────────────────────────────────────────

function Spinner() {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", background: "#f3f4f6" }}>
      <div style={{ width: 36, height: 36, border: "3px solid #0f6e56", borderTopColor: "transparent", borderRadius: "50%", animation: "spin 0.75s linear infinite" }} />
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const S: Record<string, React.CSSProperties> = {
  page: {
    display: "flex", minHeight: "100vh",
    fontFamily: "system-ui, -apple-system, sans-serif",
  },
  // Left branding panel
  left: {
    flex: 1,
    background: "linear-gradient(145deg, #0a4a38 0%, #0f6e56 60%, #16a37a 100%)",
    display: "flex", alignItems: "center", justifyContent: "center",
    padding: 48,
  },
  leftInner: { maxWidth: 440, color: "white" },
  headline: { fontSize: 32, fontWeight: 900, margin: "0 0 14px", letterSpacing: "-0.02em", lineHeight: 1.15 },
  sub: { fontSize: 15, color: "rgba(255,255,255,0.75)", margin: "0 0 28px", lineHeight: 1.6 },
  featureList: { display: "flex", flexDirection: "column" as const, gap: 10, marginBottom: 24 },
  feature: { display: "flex", alignItems: "center", gap: 10, fontSize: 14, color: "rgba(255,255,255,0.85)" },
  featureDot: { width: 6, height: 6, borderRadius: "50%", background: "rgba(255,255,255,0.6)", flexShrink: 0 },
  accessNote: {
    background: "rgba(255,255,255,0.1)", borderRadius: 10,
    borderLeft: "3px solid rgba(126,240,200,0.6)",
    padding: "12px 14px", fontSize: 13, color: "rgba(255,255,255,0.85)", lineHeight: 1.5,
  },
  // Right form panel
  right: {
    width: 480, display: "flex", alignItems: "center",
    justifyContent: "center", padding: 32, background: "#f8fafc",
  },
  card: {
    width: "100%", background: "white", borderRadius: 20, padding: "28px 32px",
    boxShadow: "0 4px 6px rgba(0,0,0,0.04), 0 20px 40px rgba(0,0,0,0.08)",
  },
  // Tabs
  tabs: {
    display: "flex", background: "#f1f5f9",
    borderRadius: 12, padding: 4, marginBottom: 28, gap: 4,
  },
  tabBtn: {
    flex: 1, padding: "9px 0", borderRadius: 9, border: "none",
    fontSize: 13, fontWeight: 700, cursor: "pointer",
    transition: "all 0.18s ease",
    fontFamily: "inherit",
  },
  tabActive: {
    background: "white", color: "#0f6e56",
    boxShadow: "0 2px 8px rgba(0,0,0,0.08)",
  },
  tabInactive: { background: "transparent", color: "#94a3b8" },
  // Form elements
  formHeader: { marginBottom: 22 },
  formTitle: { fontSize: 20, fontWeight: 800, color: "#111827", margin: "0 0 4px", letterSpacing: "-0.01em" },
  formSub: { fontSize: 13, color: "#6b7280", margin: 0 },
  label: { display: "block", fontSize: 12, fontWeight: 700, color: "#374151", marginBottom: 5, letterSpacing: "0.02em" },
  input: {
    width: "100%", padding: "10px 13px", borderRadius: 10,
    border: "1.5px solid #e2e8f0", fontSize: 14, outline: "none",
    boxSizing: "border-box" as const, color: "#1a202c",
    fontFamily: "inherit", marginBottom: 0,
    transition: "border-color 0.15s",
  },
  errorBox: {
    marginTop: 12, padding: "10px 14px",
    background: "#fef2f2", border: "1px solid #fca5a5",
    borderRadius: 10, fontSize: 13, color: "#dc2626",
  },
  primaryBtn: {
    marginTop: 18, width: "100%", padding: 13,
    borderRadius: 12, border: "none",
    background: "linear-gradient(135deg,#0f6e56,#0a5240)",
    color: "white", fontWeight: 700, fontSize: 14, cursor: "pointer",
    boxShadow: "0 4px 12px rgba(15,110,86,0.3)",
    fontFamily: "inherit",
  },
  roleNote: {
    marginTop: 14, padding: "10px 12px",
    background: "#f0fdf4", border: "1px solid #bbf7d0",
    borderRadius: 10, fontSize: 12, color: "#166534", lineHeight: 1.5,
  },
  switchText: { fontSize: 13, color: "#6b7280", textAlign: "center" as const, marginTop: 20 },
  switchLink: {
    background: "none", border: "none", color: "#0f6e56",
    fontWeight: 700, fontSize: 13, cursor: "pointer", padding: 0,
    fontFamily: "inherit",
  },
  // Dev hints
  hintBox: {
    marginTop: 20, padding: 14, background: "#f8fafc",
    borderRadius: 12, border: "1px solid #e2e8f0",
  },
  hintTitle: {
    fontSize: 10, fontWeight: 700, color: "#94a3b8",
    letterSpacing: "0.08em", textTransform: "uppercase" as const, marginBottom: 8,
  },
  hintRow: {
    display: "flex", alignItems: "center", gap: 8, width: "100%",
    padding: "5px 8px", borderRadius: 8, border: "none",
    background: "transparent", cursor: "pointer",
    textAlign: "left" as const, marginBottom: 3, fontFamily: "inherit",
  },
  hintBadge: {
    fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 99,
    textTransform: "uppercase" as const, letterSpacing: "0.05em", flexShrink: 0,
  },
  hintEmail: { fontSize: 12, color: "#4a5568" },
};
