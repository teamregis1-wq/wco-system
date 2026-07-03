"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth, type Role } from "@/lib/auth-context";

const ROLE_BADGE: Record<Role, { bg: string; color: string; label: string }> = {
  admin:      { bg: "#fef3c7", color: "#92400e",  label: "Admin" },
  researcher: { bg: "#dbeafe", color: "#1d4ed8",  label: "Researcher" },
  viewer:     { bg: "#f1f5f9", color: "#475569",  label: "Viewer" },
};

const BASE_LINKS = [
  { href: "/",               label: "Map",            adminOnly: false },
  { href: "/dashboard",      label: "Dashboard",      adminOnly: false },
  { href: "/establishments", label: "Establishments", adminOnly: false },
  { href: "/routes",         label: "Routes",         adminOnly: false },
  { href: "/admin",          label: "Admin",          adminOnly: true  },
];

export default function Navbar() {
  const { user, signOut, can } = useAuth();
  const pathname = usePathname();

  // Public (unauthenticated) users only see the map — show a minimal brand bar
  if (!user) {
    return (
      <nav style={S.nav}>
        <span style={S.brand}>WCO System</span>
        <span style={{ marginLeft: 8, fontSize: 11, color: "#94a3b8" }}>Batangas City · Public View</span>
        <div style={{ marginLeft: "auto" }}>
          <Link href="/login" style={{ fontSize: 12, color: "#0f6e56", textDecoration: "none", fontWeight: 600 }}>
            Sign in
          </Link>
        </div>
      </nav>
    );
  }

  const badge = ROLE_BADGE[user.role] ?? ROLE_BADGE.viewer;
  const links = BASE_LINKS.filter(l => !l.adminOnly || can("admin"));

  return (
    <nav style={S.nav}>
      <span style={S.brand}>WCO System</span>

      <div style={S.tabs}>
        {links.map(({ href, label }) => {
          const active = pathname === href;
          return (
            <Link key={href} href={href} style={{
              ...S.tab,
              background: active ? "#0f6e56" : "transparent",
              color:      active ? "white"   : "#64748b",
              fontWeight: active ? 700 : 500,
              boxShadow:  active ? "0 2px 8px rgba(15,110,86,0.25)" : "none",
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
        <div style={S.userInfo}>
          <span style={S.userName}>{user.full_name}</span>
          <span style={S.userEmail}>{user.email}</span>
        </div>
        <button onClick={signOut} style={S.signOutBtn}>Sign out</button>
      </div>
    </nav>
  );
}

const S: Record<string, React.CSSProperties> = {
  nav: {
    display: "flex", alignItems: "center", gap: 4,
    padding: "0 20px", height: 56, flexShrink: 0,
    background: "white", borderBottom: "1px solid #e2e8f0",
    boxShadow: "0 1px 4px rgba(0,0,0,0.05)",
    fontFamily: "system-ui, -apple-system, sans-serif",
  },
  brand: {
    fontWeight: 900, fontSize: 15, color: "#0f6e56",
    letterSpacing: "-0.02em", marginRight: 12, flexShrink: 0,
  },
  tabs: { display: "flex", alignItems: "center", gap: 2 },
  tab: {
    display: "flex", alignItems: "center", gap: 6,
    fontSize: 13, textDecoration: "none",
    padding: "6px 14px", borderRadius: 9,
    transition: "all 0.15s ease",
    flexShrink: 0, whiteSpace: "nowrap",
  },
  right: { marginLeft: "auto", display: "flex", alignItems: "center", gap: 12 },
  badge: {
    fontSize: 10, fontWeight: 800, padding: "3px 9px", borderRadius: 99,
    letterSpacing: "0.06em", textTransform: "uppercase" as const, flexShrink: 0,
  },
  userInfo: { display: "flex", flexDirection: "column" as const, alignItems: "flex-end" },
  userName:  { fontSize: 12, fontWeight: 700, color: "#1a202c", lineHeight: 1.3 },
  userEmail: { fontSize: 10, color: "#a0aec0", lineHeight: 1.3 },
  signOutBtn: {
    fontSize: 12, color: "#94a3b8", background: "none",
    border: "1px solid #e2e8f0", borderRadius: 8,
    cursor: "pointer", padding: "5px 10px",
  },
};
