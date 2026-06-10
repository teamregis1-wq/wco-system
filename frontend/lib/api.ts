// Lightweight API client for the FastAPI backend.
// Stores the JWT in memory + localStorage and attaches it to every request.

const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000/api/v1";

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

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string>),
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`API ${res.status}: ${detail}`);
  }
  // 204 No Content
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

// --- Auth -------------------------------------------------------------------

export async function login(email: string, password: string): Promise<void> {
  // The backend login expects form-encoded data (OAuth2 standard).
  const body = new URLSearchParams();
  body.set("username", email);
  body.set("password", password);

  const res = await fetch(`${API_BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error("Login failed");
  const data = (await res.json()) as { access_token: string };
  setToken(data.access_token);
}

// --- Types ------------------------------------------------------------------

export interface Establishment {
  id: number;
  wco_code: string;
  name: string;
  type: string;
  barangay: string | null;
  latitude: number;
  longitude: number;
}

export interface Hotspot {
  establishment_id: number;
  name: string;
  latitude: number;
  longitude: number;
  score: number;
  category: "high" | "medium" | "low";
}

export interface ForecastPoint {
  week_date: string;
  predicted_liters: number;
}

export interface ForecastResponse {
  establishment_id: number;
  model_version: string;
  points: ForecastPoint[];
}

// --- Endpoints --------------------------------------------------------------

export const api = {
  establishments: () => request<Establishment[]>("/establishments"),
  gisEstablishments: () => request<Establishment[]>("/gis/establishments"),
  hotspots: () => request<Hotspot[]>("/gis/hotspots"),
  forecast: (id: number, horizon = 12) =>
    request<ForecastResponse>(`/forecast/${id}?horizon_weeks=${horizon}`),
  simulations: () => request<unknown[]>("/simulations"),
};
