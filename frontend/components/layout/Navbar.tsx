"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth, type Role } from "@/lib/auth-context";
import { LogoMark } from "@/components/layout/Logo";
import { brandFont } from "@/lib/fonts";
import { greenGradient } from "@/lib/theme";
import ChangePasswordModal from "@/components/auth/ChangePasswordModal";

const ROLE_BADGE: Record<Role, { bg: string; color: string; label: string }> = {
  admin:      { bg: "rgba(254,243,199,0.9)", color: "#92400e",  label: "Admin" },
  researcher: { bg: "rgba(219,234,254,0.9)", color: "#1d4ed8",  label: "Researcher" },
  viewer:     { bg: "rgba(241,245,249,0.9)", color: "#475569",  label: "Viewer" },
};

const BASE_LINKS = [
  { href: "/map",            label: "Map",            adminOnly: false },
  { href: "/dashboard",      label: "Dashboard",      adminOnly: false },
  { href: "/establishments", label: "Establishments", adminOnly: false },
  { href: "/routes",         label: "Routes",         adminOnly: false },
  { href: "/admin",          label: "Admin",          adminOnly: true  },
];

export default function Navbar() {
  const { user, signOut, can } = useAuth();
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const [pwOpen, setPwOpen] = useState(false);
  useEffect(() => { setMenuOpen(false); }, [pathname]);
  if (!user) return null;

  const badge = ROLE_BADGE[user.role] ?? ROLE_BADGE.viewer;
  const links = BASE_LINKS.filter(l => !l.adminOnly || can("admin"));

  return (
    <nav className="wco-noprint" style={S.nav}>
      <Link href="/" style={S.brand} title="WCO Atlas home">
        <LogoMark size={30} />
        <span className={brandFont.className} style={S.brandText}>WCO&nbsp;Atlas</span>
      </Link>

      <div className="wco-nav-tabs" style={S.tabs}>
        {links.map(({ href, label }) => {
          const active = pathname === href;
          return (
            <Link key={href} href={href} style={{
              ...S.tab,
              background: active ? greenGradient : "transparent",
              color:      active ? "white"   : "#3b5f55",
              fontWeight: active ? 700 : 500,
              boxShadow:  active ? "0 4px 12px rgba(15,110,86,0.28)" : "none",
            }}>
              {label}
            </Link>
          );
        })}
      </div>

      <div style={S.right}>
        <span style={{ ...S.badge, background: badge.bg, color: badge.color }}>
          {badge.label}
        </span>
        <div className="wco-nav-user" style={S.userInfo}>
          <span style={S.userName}>{user.full_name}</span>
          <span style={S.userEmail}>{user.email}</span>
        </div>
        <button className="wco-nav-signout" onClick={() => setPwOpen(true)} style={S.iconBtn}
          title="Change password" aria-label="Change password">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#3b5f55" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <circle cx="7.5" cy="15.5" r="4.5" /><path d="M10.7 12.3L21 2" /><path d="M16 7l3 3" /><path d="M18.5 4.5l2 2" />
          </svg>
        </button>
        <button className="wco-nav-signout" onClick={signOut} style={S.signOutBtn}>Sign out</button>
        <button
          className="wco-nav-burger"
          aria-label={menuOpen ? "Close menu" : "Open menu"}
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen(o => !o)}
          style={S.burger}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#0f6e56" strokeWidth="2.2" strokeLinecap="round">
            {menuOpen
              ? <><path d="M6 6l12 12" /><path d="M18 6L6 18" /></>
              : <><path d="M4 7h16" /><path d="M4 12h16" /><path d="M4 17h16" /></>}
          </svg>
        </button>
      </div>

      {/* Phone / tablet menu */}
      <div className={`wco-nav-sheet${menuOpen ? " open" : ""}`} style={S.sheet}>
        {links.map(({ href, label }) => {
          const active = pathname === href;
          return (
            <Link key={href} href={href} style={{
              ...S.sheetLink,
              background: active ? greenGradient : "rgba(255,255,255,0.55)",
              color: active ? "white" : "#1f3d35",
            }}>
              {label}
            </Link>
          );
        })}
        <div style={S.sheetUser}>
          <div style={{ minWidth: 0 }}>
            <div style={S.userName}>{user.full_name}</div>
            <div style={{ ...S.userEmail, overflow: "hidden", textOverflow: "ellipsis" }}>{user.email}</div>
          </div>
          <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
            <button onClick={() => { setMenuOpen(false); setPwOpen(true); }} style={S.signOutBtn}>Change password</button>
            <button onClick={signOut} style={S.signOutBtn}>Sign out</button>
          </div>
        </div>
      </div>

      {/* Rendered at <body> level: the nav's backdrop-filter would otherwise trap a fixed overlay. */}
      {pwOpen && createPortal(<ChangePasswordModal onClose={() => setPwOpen(false)} />, document.body)}
    </nav>
  );
}

const S: Record<string, React.CSSProperties> = {
  nav: {
    position: "relative", zIndex: 1000,
    display: "flex", alignItems: "center", gap: 4,
    padding: "0 16px", height: 58, flexShrink: 0,
    background: "rgba(255,255,255,0.68)",
    backdropFilter: "blur(18px) saturate(170%)", WebkitBackdropFilter: "blur(18px) saturate(170%)",
    borderBottom: "1px solid rgba(15,110,86,0.10)",
    boxShadow: "0 6px 24px rgba(15,110,86,0.08)",
    fontFamily: "system-ui, -apple-system, sans-serif",
  },
  brand: {
    display: "flex", alignItems: "center", gap: 8,
    textDecoration: "none", marginRight: 14, flexShrink: 0,
  },
  brandText: {
    fontWeight: 700, fontSize: 16, color: "#0f6e56",
    letterSpacing: "-0.02em",
  },
  tabs: { display: "flex", alignItems: "center", gap: 2 },
  tab: {
    display: "flex", alignItems: "center", gap: 6,
    fontSize: 13, textDecoration: "none",
    padding: "7px 14px", borderRadius: 10,
    transition: "all 0.15s ease",
    flexShrink: 0, whiteSpace: "nowrap",
  },
  right: { marginLeft: "auto", display: "flex", alignItems: "center", gap: 10, minWidth: 0 },
  badge: {
    fontSize: 10, fontWeight: 800, padding: "3px 9px", borderRadius: 99,
    letterSpacing: "0.06em", textTransform: "uppercase" as const, flexShrink: 0,
  },
  userInfo: { display: "flex", flexDirection: "column" as const, alignItems: "flex-end" },
  userName:  { fontSize: 12, fontWeight: 700, color: "#1a202c", lineHeight: 1.3 },
  userEmail: { fontSize: 10, color: "#6b8a80", lineHeight: 1.3 },
  signOutBtn: {
    fontSize: 12, color: "#3b5f55", background: "rgba(255,255,255,0.6)",
    border: "1px solid rgba(15,110,86,0.16)", borderRadius: 9,
    cursor: "pointer", padding: "6px 11px", flexShrink: 0,
  },
  iconBtn: {
    display: "inline-flex", alignItems: "center", justifyContent: "center",
    width: 32, height: 30, background: "rgba(255,255,255,0.6)",
    border: "1px solid rgba(15,110,86,0.16)", borderRadius: 9, cursor: "pointer", flexShrink: 0,
  },
  burger: {
    alignItems: "center", justifyContent: "center", width: 40, height: 40,
    borderRadius: 11, border: "1px solid rgba(15,110,86,0.18)",
    background: "rgba(255,255,255,0.7)", cursor: "pointer", flexShrink: 0,
  },
  sheet: {
    position: "absolute", top: 58, left: 0, right: 0,
    flexDirection: "column", gap: 6, padding: 12,
    background: "rgba(248,253,250,0.985)",
    backdropFilter: "blur(20px) saturate(170%)", WebkitBackdropFilter: "blur(20px) saturate(170%)",
    borderBottom: "1px solid rgba(15,110,86,0.12)",
    boxShadow: "0 18px 40px rgba(15,110,86,0.16)",
  },
  sheetLink: {
    display: "block", padding: "12px 14px", borderRadius: 12, textDecoration: "none",
    fontSize: 14, fontWeight: 700,
  },
  sheetUser: {
    display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
    marginTop: 4, padding: "10px 4px 2px", borderTop: "1px solid rgba(15,110,86,0.12)",
  },
};
