// Thin fetch client for the Express API. Attaches the JWT from localStorage
// and normalizes error handling.

// Default to same-origin ("") so the browser calls /api/... on the Next.js
// server, which proxies to the Express API (see next.config.mjs rewrites).
// Set NEXT_PUBLIC_API_URL only if you run the API on a separate origin.
const BASE = process.env.NEXT_PUBLIC_API_URL ?? "";
const TOKEN_KEY = "dca_token";

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null): void {
  if (typeof window === "undefined") return;
  if (token) window.localStorage.setItem(TOKEN_KEY, token);
  else window.localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const res = await fetch(`${BASE}${path}`, { ...init, headers });

  if (res.status === 204) return undefined as T;

  let body: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    if (body && typeof body === "object" && "error" in body) {
      message = String((body as { error: unknown }).error);
    }
    throw new ApiError(res.status, message);
  }
  return body as T;
}
