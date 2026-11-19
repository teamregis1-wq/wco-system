/**
 * Auth token storage.
 *
 * Each page defines its own `apiFetch` (they need different error handling),
 * so this module only owns the JWT and the types shared across components.
 */

/**
 * Base URL of the FastAPI backend, used by browser code only.
 *
 * - Deployed on Vercel (frontend and backend as Services on ONE domain):
 *   same-origin "/api/v1" — the default when NEXT_PUBLIC_API_BASE is unset.
 * - Local two-terminal development (next dev on :3000, uvicorn on :8000):
 *   set NEXT_PUBLIC_API_BASE=http://localhost:8000/api/v1 in frontend/.env.local.
 *
 * NEXT_PUBLIC_ values are inlined at BUILD time; change them and rebuild/redeploy.
 */
export const API_BASE = (process.env.NEXT_PUBLIC_API_BASE || "/api/v1").replace(/\/+$/, "");

const TOKEN_KEY = "wco_token";

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

/** One point on a forecast series — shared by the map, charts, and dashboard. */
export interface ForecastPoint {
  week_date: string;
  predicted_liters: number;
}
