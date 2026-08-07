"use client";

import {
  createContext, useContext, useEffect, useState,
  useCallback, type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { getToken, clearToken, setToken } from "@/lib/api";

// ── Types ─────────────────────────────────────────────────────────────────────

export type Role = "admin" | "researcher" | "viewer";
export type Action = "read" | "edit" | "delete" | "admin";

export interface User {
  id: number;
  email: string;
  full_name: string;
  role: Role;
  created_at: string;
}

interface AuthCtx {
  user:    User | null;
  loading: boolean;
  signIn:  (email: string, password: string) => Promise<void>;
  signOut: () => void;
  can:     (action: Action) => boolean;
}

// ── Permission table ──────────────────────────────────────────────────────────

const PERMISSIONS: Record<Role, Action[]> = {
  admin:      ["read", "edit", "delete", "admin"],
  researcher: ["read", "edit"],
  viewer:     ["read"],
};

// ── Context ───────────────────────────────────────────────────────────────────

const AuthContext = createContext<AuthCtx>({
  user: null, loading: true,
  signIn: async () => {}, signOut: () => {}, can: () => false,
});

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000/api/v1";

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user,    setUser]    = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  // Rehydrate session from saved token on mount
  useEffect(() => {
    const token = getToken();
    if (!token) { setLoading(false); return; }

    fetch(`${API_BASE}/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => { if (!r.ok) throw new Error("expired"); return r.json(); })
      .then((u: User) => setUser(u))
      .catch(() => { clearToken(); setUser(null); })
      .finally(() => setLoading(false));
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const body = new URLSearchParams({ username: email, password });
    let res: Response;
    try {
      res = await fetch(`${API_BASE}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
    } catch {
      throw new Error("Cannot reach the server. Make sure the backend is running.");
    }
    if (res.status === 401) throw new Error("Incorrect email or password.");
    if (!res.ok) throw new Error(`Login failed (${res.status}).`);
    const { access_token, user: loginUser } =
      await res.json() as { access_token: string; user?: User };
    setToken(access_token);

    // The login response includes the user; only fall back to /auth/me if absent.
    if (loginUser) {
      setUser(loginUser);
      return;
    }
    const meRes = await fetch(`${API_BASE}/auth/me`, {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    if (!meRes.ok) { clearToken(); throw new Error("Session error. Please try again."); }
    const me: User = await meRes.json();
    setUser(me);
  }, []);

  const signOut = useCallback(() => {
    clearToken();
    setUser(null);
    router.push("/");
  }, [router]);

  const can = useCallback((action: Action): boolean => {
    if (!user) return false;
    return PERMISSIONS[user.role]?.includes(action) ?? false;
  }, [user]);

  return (
    <AuthContext.Provider value={{ user, loading, signIn, signOut, can }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
