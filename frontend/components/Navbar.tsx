"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth, type Role } from "@/lib/auth-context";
import { LogoMark } from "@/components/Logo";
import { brandFont } from "@/lib/fonts";

const ROLE_BADGE: Record<Role, { bg: string; color: string; label: string }> = {
  admin:      { bg: "#fef3c7", color: "#92400e",  label: "Admin" },
  researcher: { bg: "#dbeafe", color: "#1d4ed8",  label: "Researcher" },
  viewer:     { bg: "#f1f5f9", color: "#475569",  label: "Viewer" },
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
  if (!user) return null;

  const badge = ROLE_BADGE[user.role] ?? ROLE_BADGE.viewer;
  const links = BASE_LINKS.filter(l => !l.adminOnly || can("admin"));

  return (
    <nav style={S.nav}>
      <Link href="/" style={S.brand} title="WCO Atlas home">
        <LogoMark size={30} />
        <span className={brandFont.className} style={S.brandText}>WCO&nbsp;Atlas</span>
      </Link>

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
