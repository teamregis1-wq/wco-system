"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useAuth } from "@/lib/auth-context";
import { LogoMark, LogoWordmark } from "@/components/Logo";
import { brandFont } from "@/lib/fonts";
import AuthPopover from "@/components/AuthPopover";

const FEATURES = [
  {
    icon: "trend",
    title: "LSTM Forecasting",
    text: "A deep-learning model trained on weekly collection history projects each establishment's waste cooking oil output three months ahead.",
  },
  {
    icon: "pin",
    title: "Hotspot Mapping",
    text: "Getis-Ord Gi* spatial statistics and volume-weighted density heatmaps reveal where WCO generation clusters across Batangas City.",
  },
  {
    icon: "route",
    title: "Route Optimization",
    text: "Collection routes follow real roads via OpenStreetMap routing, ordered to minimise total travel distance from your depot.",
  },
  {
    icon: "building",
    title: "Establishment Registry",
    text: "A geocoded database of restaurants, fast food chains, and food processors with per-site collection records and data completeness tracking.",
  },
  {
    icon: "chart",
    title: "Analytics Dashboard",
    text: "City-wide totals, weekly trends, barangay breakdowns, and forecast confidence — all in one live view.",
  },
  {
    icon: "shield",
    title: "Role-Based Access",
    text: "Admin, researcher, and viewer roles keep data entry controlled while your whole team can explore the maps.",
  },
];

// ── Inline SVG feature icons ──────────────────────────────────────────────────

const ICON_PATHS: Record<string, React.ReactNode> = {
  trend: (
    <>
      <path d="M3 17l6-6 4 4 8-8" />
      <path d="M14 7h7v7" />
    </>
  ),
  pin: (
    <>
      <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 1 1 16 0z" />
      <circle cx="12" cy="10" r="3" />
    </>
  ),
  route: (
    <>
      <circle cx="6" cy="19" r="2" />
      <circle cx="18" cy="5" r="2" />
      <path d="M8 19h7a4 4 0 0 0 0-8H9a4 4 0 0 1 0-8h7" />
    </>
  ),
  building: (
    <>
      <path d="M3 21h18" />
      <path d="M5 21V7l7-4 7 4v14" />
      <path d="M9 21v-6h6v6" />
    </>
  ),
  chart: (
    <>
      <path d="M3 3v18h18" />
      <path d="M8 16v-5" />
      <path d="M13 16V8" />
      <path d="M18 16v-8" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3l8 3v6c0 4.5-3.4 7.8-8 9-4.6-1.2-8-4.5-8-9V6l8-3z" />
      <path d="M9 12l2 2 4-4" />
    </>
  ),
};

function FeatureIcon({ name }: { name: string }) {
  return (
    <svg
      width={26} height={26} viewBox="0 0 24 24" fill="none"
      stroke="#7ef0c8" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true"
    >
      {ICON_PATHS[name]}
    </svg>
  );
}

// ── Live broadcast ticker ─────────────────────────────────────────────────────

const TICKER_ITEMS = [
  "System online",
  "Coverage: Batangas City",
  "Forecast model: LSTM · 13-week horizon",
  "Hotspot analysis: Getis-Ord Gi*",
  "Density mapping: volume-weighted KDE",
  "Routing engine: OSRM road network",
  "Data updated weekly by field teams",
];

function LiveTicker() {
  // Track is doubled so the -50% translate loops seamlessly.
  const items = [...TICKER_ITEMS, ...TICKER_ITEMS];
  return (
    <div style={S.tickerWrap}>
      <div style={S.tickerLabel}>
        <span className="wco-live-dot" style={S.liveDot} />
        LIVE
      </div>
      <div style={S.tickerViewport}>
        <div className="wco-ticker-track" style={S.tickerTrack}>
          {items.map((t, i) => (
            <span key={i} style={S.tickerItem}>
              {t}
              <span style={S.tickerSep}>•</span>
            </span>
          ))}
        </div>
      </div>
      <style>{`
        @keyframes wco-ticker { from { transform: translateX(0); } to { transform: translateX(-50%); } }
        .wco-ticker-track { animation: wco-ticker 32s linear infinite; }
        @keyframes wco-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
        .wco-live-dot { animation: wco-pulse 1.6s ease-in-out infinite; }
      `}</style>
    </div>
  );
}

const STEPS = [
  { n: "01", title: "Record", text: "Field teams log weekly WCO volumes per establishment." },
  { n: "02", title: "Analyze", text: "The system scores hotspots and forecasts future generation." },
  { n: "03", title: "Collect", text: "Optimized routes guide crews to the highest-yield stops." },
];

export default function LandingPage() {
  const { user, loading } = useAuth();
  const [authOpen, setAuthOpen] = useState(false);
  const ctaLabel = loading ? "…" : user ? "Open the Map" : "Sign In to Get Started";

  // Protected pages redirect here with ?signin=1 — auto-open the popover.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (new URLSearchParams(window.location.search).get("signin")) {
      setAuthOpen(true);
      window.history.replaceState(null, "", "/");
    }
  }, []);

  function openAuth() {
    window.scrollTo({ top: 0, behavior: "smooth" });
    setAuthOpen(true);
  }

  return (
    <main style={S.page}>
      {/* ── Top nav ── */}
      <nav style={S.nav}>
        <LogoWordmark size={38} color="white" subtitleColor="rgba(255,255,255,0.55)" />
        <div style={{ display: "flex", alignItems: "center", gap: 10, position: "relative" }}>
          {user && <span style={S.navHello}>Signed in as {user.full_name}</span>}
          {user
            ? <Link href="/map" style={S.navBtn}>Open App</Link>
            : <button onClick={() => setAuthOpen(v => !v)} style={{ ...S.navBtn, border: "none", cursor: "pointer", fontFamily: "inherit" }}>Sign In</button>
          }
          <AuthPopover open={authOpen && !user} onClose={() => setAuthOpen(false)} />
        </div>
      </nav>

      {/* ── Live broadcast strip ── */}
      <LiveTicker />

      {/* ── Hero ── */}
      <header style={S.hero}>
        <div style={S.heroBadge}>Batangas City · Waste-to-Energy Initiative</div>
        <h1 className={brandFont.className} style={S.heroTitle}>
          Every litre of used cooking oil,<br />
          <span style={S.heroAccent}>mapped, forecast, and collected.</span>
        </h1>
        <p style={S.heroSub}>
          WCO Atlas turns weekly collection records into city-wide intelligence — spatial
          hotspot analysis, three-month AI forecasts, and road-accurate collection routes
          for waste cooking oil recovery.
        </p>
        <div style={S.heroCtas}>
          {user
            ? <Link href="/map" style={S.ctaPrimary}>{ctaLabel}</Link>
            : <button onClick={openAuth} style={{ ...S.ctaPrimary, border: "none", cursor: "pointer", fontFamily: "inherit" }}>{ctaLabel}</button>
          }
          <a
            href="#features"
            style={S.ctaGhost}
            onClick={e => {
              e.preventDefault();
              document.getElementById("features")?.scrollIntoView({ behavior: "smooth", block: "start" });
            }}
          >
            Explore Features <span className="wco-scroll-arrow" style={{ display: "inline-block", marginLeft: 4 }}>↓</span>
          </a>
          <style>{`
            @keyframes wco-bounce {
              0%, 100% { transform: translateY(0); }
              50%      { transform: translateY(4px); }
            }
            .wco-scroll-arrow { animation: wco-bounce 1.6s ease-in-out infinite; }
          `}</style>
        </div>

        {/* Stats strip */}
        <div style={S.statsRow}>
          {[
            ["Gi*", "Spatial hotspot statistic"],
            ["13 wk", "LSTM forecast horizon"],
            ["OSRM", "Road-network routing"],
            ["KDE", "Density heat mapping"],
          ].map(([big, small]) => (
            <div key={big as string} style={S.stat}>
              <div style={S.statBig}>{big}</div>
              <div style={S.statSmall}>{small}</div>
            </div>
          ))}
        </div>
      </header>

      {/* ── Features ── */}
      <section id="features" style={S.section}>
        <h2 className={brandFont.className} style={S.sectionTitle}>Everything the collection program needs</h2>
        <p style={S.sectionSub}>
          From the first field record to the truck's final stop — one system, one map.
        </p>
        <div style={S.grid}>
          {FEATURES.map(f => (
            <div key={f.title} style={S.card}>
              <div style={S.cardIcon}><FeatureIcon name={f.icon} /></div>
              <div style={S.cardTitle}>{f.title}</div>
              <div style={S.cardText}>{f.text}</div>
            </div>
          ))}
        </div>
      </section>

      {/* ── How it works ── */}
      <section style={{ ...S.section, paddingTop: 0 }}>
        <h2 className={brandFont.className} style={S.sectionTitle}>How it works</h2>
        <div style={S.stepsRow}>
          {STEPS.map((s, i) => (
            <div key={s.n} style={S.step}>
              <div style={S.stepNum}>{s.n}</div>
              <div>
                <div style={S.stepTitle}>{s.title}</div>
                <div style={S.stepText}>{s.text}</div>
              </div>
              {i < STEPS.length - 1 && <div style={S.stepArrow}>→</div>}
            </div>
          ))}
        </div>
      </section>

      {/* ── Bottom CTA ── */}
      <section style={S.bottomCta}>
        <LogoMark size={52} />
        <h2 className={brandFont.className} style={S.bottomTitle}>Ready to see the map?</h2>
        <p style={S.bottomSub}>
          Access is provided to authorized members of the organization.
          Create an account and an administrator will assign your role.
        </p>
        {user
          ? <Link href="/map" style={S.ctaPrimary}>{ctaLabel}</Link>
          : <button onClick={openAuth} style={{ ...S.ctaPrimary, border: "none", cursor: "pointer", fontFamily: "inherit" }}>{ctaLabel}</button>
        }
      </section>

      {/* ── Footer ── */}
      <footer style={S.footer}>
        <LogoWordmark size={28} color="rgba(255,255,255,0.9)" subtitle={null} />
        <span style={S.footerText}>
          Waste Cooking Oil Predictive Mapping System · Batangas City · {new Date().getFullYear()}
        </span>
      </footer>
    </main>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const S: Record<string, React.CSSProperties> = {
  page: {
    minHeight: "100vh",
    background: "linear-gradient(170deg, #06281e 0%, #0a4a38 42%, #0f6e56 100%)",
    fontFamily: "system-ui, -apple-system, sans-serif",
    color: "white",
  },
  nav: {
    display: "flex", alignItems: "center", justifyContent: "space-between",
    padding: "18px 40px", maxWidth: 1180, margin: "0 auto",
  },
  navHello: { fontSize: 12, color: "rgba(255,255,255,0.6)" },
  navBtn: {
    fontSize: 13, fontWeight: 700, color: "#0f3d30",
    background: "white", padding: "9px 20px", borderRadius: 99,
    textDecoration: "none", boxShadow: "0 2px 12px rgba(0,0,0,0.18)",
  },
  // Live ticker
  tickerWrap: {
    display: "flex", alignItems: "center",
    borderTop: "1px solid rgba(255,255,255,0.1)",
    borderBottom: "1px solid rgba(255,255,255,0.1)",
    background: "rgba(0,0,0,0.18)",
  },
  tickerLabel: {
    display: "flex", alignItems: "center", gap: 7,
    fontSize: 11, fontWeight: 900, letterSpacing: "0.14em",
    color: "#ff6b6b", padding: "9px 18px",
    borderRight: "1px solid rgba(255,255,255,0.1)",
    flexShrink: 0,
  },
  liveDot: {
    width: 8, height: 8, borderRadius: "50%",
    background: "#ff5c5c", boxShadow: "0 0 8px rgba(255,92,92,0.8)",
  },
  tickerViewport: { flex: 1, overflow: "hidden", whiteSpace: "nowrap" },
  tickerTrack: { display: "inline-flex", alignItems: "center", whiteSpace: "nowrap", width: "max-content" },
  tickerItem: {
    display: "inline-flex", alignItems: "center",
    fontSize: 12, fontWeight: 600, letterSpacing: "0.04em",
    color: "rgba(255,255,255,0.68)", textTransform: "uppercase",
  },
  tickerSep: { color: "rgba(126,240,200,0.55)", margin: "0 22px", fontSize: 10 },
  hero: {
    maxWidth: 900, margin: "0 auto", textAlign: "center",
    padding: "72px 24px 56px",
  },
  heroBadge: {
    display: "inline-block", fontSize: 12, fontWeight: 700,
    letterSpacing: "0.1em", textTransform: "uppercase",
    color: "#7ef0c8", background: "rgba(126,240,200,0.1)",
    border: "1px solid rgba(126,240,200,0.3)",
    padding: "6px 16px", borderRadius: 99, marginBottom: 26,
  },
  heroTitle: {
    fontSize: "clamp(34px, 5.4vw, 58px)", fontWeight: 900,
    letterSpacing: "-0.03em", lineHeight: 1.08, margin: "0 0 22px",
  },
  heroAccent: {
    background: "linear-gradient(90deg, #7ef0c8, #3ecf9a)",
    WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent",
  },
  heroSub: {
    fontSize: 17, lineHeight: 1.65, color: "rgba(255,255,255,0.72)",
    maxWidth: 640, margin: "0 auto 34px",
  },
  heroCtas: { display: "flex", gap: 14, justifyContent: "center", flexWrap: "wrap", marginBottom: 54 },
  ctaPrimary: {
    display: "inline-block", fontSize: 15, fontWeight: 800,
    color: "#06281e", background: "linear-gradient(90deg, #7ef0c8, #3ecf9a)",
    padding: "14px 34px", borderRadius: 99, textDecoration: "none",
    boxShadow: "0 6px 24px rgba(62,207,154,0.35)",
  },
  ctaGhost: {
    display: "inline-block", fontSize: 15, fontWeight: 700,
    color: "rgba(255,255,255,0.85)", background: "rgba(255,255,255,0.08)",
    border: "1px solid rgba(255,255,255,0.22)",
    padding: "14px 30px", borderRadius: 99, textDecoration: "none",
  },
  statsRow: {
    display: "flex", justifyContent: "center", gap: 12, flexWrap: "wrap",
  },
  stat: {
    background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.12)",
    borderRadius: 16, padding: "16px 26px", minWidth: 150,
  },
  statBig: { fontSize: 24, fontWeight: 900, color: "#7ef0c8", letterSpacing: "-0.02em" },
  statSmall: { fontSize: 11.5, color: "rgba(255,255,255,0.6)", marginTop: 3 },
  section: {
    maxWidth: 1080, margin: "0 auto", padding: "64px 24px", textAlign: "center",
  },
  sectionTitle: {
    fontSize: "clamp(26px, 3.4vw, 36px)", fontWeight: 900,
    letterSpacing: "-0.02em", margin: "0 0 10px",
  },
  sectionSub: { fontSize: 15, color: "rgba(255,255,255,0.65)", margin: "0 0 40px" },
  grid: {
    display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
    gap: 18, textAlign: "left",
  },
  card: {
    background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.11)",
    borderRadius: 18, padding: "26px 24px",
    backdropFilter: "blur(4px)",
  },
  cardIcon: {
    display: "inline-flex", alignItems: "center", justifyContent: "center",
    width: 48, height: 48, borderRadius: 13, marginBottom: 14,
    background: "rgba(126,240,200,0.08)", border: "1px solid rgba(126,240,200,0.22)",
  },
  cardTitle: { fontSize: 17, fontWeight: 800, marginBottom: 8, letterSpacing: "-0.01em" },
  cardText: { fontSize: 13.5, lineHeight: 1.65, color: "rgba(255,255,255,0.68)" },
  stepsRow: {
    display: "flex", justifyContent: "center", gap: 20,
    flexWrap: "wrap", marginTop: 34,
  },
  step: {
    display: "flex", alignItems: "flex-start", gap: 14, textAlign: "left",
    background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.11)",
    borderRadius: 16, padding: "20px 22px", maxWidth: 300, position: "relative",
  },
  stepNum: {
    fontSize: 22, fontWeight: 900, color: "#7ef0c8",
    letterSpacing: "-0.02em", lineHeight: 1, marginTop: 2,
  },
  stepTitle: { fontSize: 15, fontWeight: 800, marginBottom: 5 },
  stepText: { fontSize: 12.5, lineHeight: 1.6, color: "rgba(255,255,255,0.65)" },
  stepArrow: { position: "absolute", right: -22, top: "44%", color: "rgba(255,255,255,0.35)", fontSize: 18 },
  bottomCta: {
    maxWidth: 620, margin: "0 auto", textAlign: "center",
    padding: "30px 24px 80px",
    display: "flex", flexDirection: "column", alignItems: "center", gap: 16,
  },
  bottomTitle: { fontSize: 30, fontWeight: 900, letterSpacing: "-0.02em", margin: 0 },
  bottomSub: { fontSize: 14.5, lineHeight: 1.65, color: "rgba(255,255,255,0.68)", margin: "0 0 8px" },
  footer: {
    display: "flex", alignItems: "center", justifyContent: "space-between",
    flexWrap: "wrap", gap: 12,
    maxWidth: 1180, margin: "0 auto",
    padding: "22px 40px", borderTop: "1px solid rgba(255,255,255,0.12)",
  },
  footerText: { fontSize: 12, color: "rgba(255,255,255,0.5)" },
};
