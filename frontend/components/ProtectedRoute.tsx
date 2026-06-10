"use client";

import { useEffect, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useAuth, type Action } from "@/lib/auth-context";

// ── ProtectedRoute ────────────────────────────────────────────────────────────
// Wrap any page that requires authentication.
// Optional `require` prop restricts to a specific action (e.g. "admin").

interface Props {
  children: ReactNode;
  require?: Action;
}

export default function ProtectedRoute({ children, require: requiredAction }: Props) {
  const { user, loading, can } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !user) router.push("/login");
  }, [user, loading, router]);

  if (loading) return <LoadingScreen />;
  if (!user)   return null; // redirect in progress

  if (requiredAction && !can(requiredAction)) {
    return <AccessDenied role={user.role} required={requiredAction} />;
  }

  return <>{children}</>;
}

// ── RoleGuard ─────────────────────────────────────────────────────────────────
// Conditionally render UI elements based on the user's permissions.
// Use anywhere inside a ProtectedRoute tree.
//
// Usage:
//   <RoleGuard action="edit"><button>Edit</button></RoleGuard>
//   <RoleGuard action="delete" fallback={<span>No access</span>}>…</RoleGuard>

interface GuardProps {
  action:    Action;
  children:  ReactNode;
  fallback?: ReactNode;
}

export function RoleGuard({ action, children, fallback }: GuardProps) {
  const { can } = useAuth();
  if (can(action)) return <>{children}</>;
  return fallback ? <>{fallback}</> : null;
}

// ── Loading screen ────────────────────────────────────────────────────────────

function LoadingScreen() {
  return (
    <div style={{
      display: "flex", flexDirection: "column",
      alignItems: "center", justifyContent: "center",
      height: "100vh", gap: 16, background: "#f8fafc",
      fontFamily: "system-ui, sans-serif",
    }}>
      <div style={{
        width: 40, height: 40,
        border: "3px solid #0f6e56",
        borderTopColor: "transparent",
        borderRadius: "50%",
        animation: "spin 0.75s linear infinite",
      }} />
      <span style={{ fontSize: 13, color: "#718096" }}>Loading…</span>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

// ── Access denied screen ──────────────────────────────────────────────────────

function AccessDenied({ role, required }: { role: string; required: Action }) {
  const router = useRouter();
  return (
    <div style={{
      display: "flex", flexDirection: "column",
      alignItems: "center", justifyContent: "center",
      height: "100vh", gap: 16, background: "#f8fafc",
      fontFamily: "system-ui, sans-serif", textAlign: "center",
      padding: 24,
    }}>
      <div style={{
        width: 56, height: 56, borderRadius: "50%",
        background: "#fef2f2", display: "flex",
        alignItems: "center", justifyContent: "center",
        fontSize: 26,
      }}>
        🔒
      </div>
      <div>
        <h2 style={{ fontSize: 20, fontWeight: 800, color: "#1a202c", margin: "0 0 6px" }}>
          Access Restricted
        </h2>
        <p style={{ fontSize: 13, color: "#718096", margin: 0 }}>
          This page requires <strong>{required}</strong> permission.
          Your current role is <strong>{role}</strong>.
        </p>
      </div>
      <button
        onClick={() => router.back()}
        style={{
          padding: "9px 20px", borderRadius: 10, border: "1px solid #e2e8f0",
          background: "white", fontSize: 13, fontWeight: 600,
          color: "#374151", cursor: "pointer",
        }}
      >
        ← Go back
      </button>
    </div>
  );
}
