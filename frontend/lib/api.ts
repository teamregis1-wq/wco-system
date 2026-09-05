/**
 * Auth token storage.
 *
 * Each page defines its own `apiFetch` (they need different error handling),
 * so this module only owns the JWT and the types shared across components.
 */

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
