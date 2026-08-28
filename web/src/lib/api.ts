/**
 * Thin client for the sync API.
 *
 * Same-origin by design, so there is no base URL to configure and nothing to
 * bake in at build time. The access token lives in memory only; the refresh
 * token is the one thing kept in storage, because a browser reload must not
 * mean signing in again.
 */

export interface ApiErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface Session {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  deviceId: string;
  userId: string;
}

const REFRESH_STORAGE_KEY = "ravelon-sync.refresh";
/** Refreshed a little early, so a request never races its own expiry. */
const REFRESH_MARGIN_MS = 60_000;

let session: Session | null = null;
let refreshInFlight: Promise<Session> | null = null;
const listeners = new Set<(session: Session | null) => void>();

export function getSession(): Session | null {
  return session;
}

export function onSessionChange(listener: (session: Session | null) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function setSession(next: Session | null): void {
  session = next;
  try {
    if (next) {
      localStorage.setItem(REFRESH_STORAGE_KEY, next.refreshToken);
    } else {
      localStorage.removeItem(REFRESH_STORAGE_KEY);
    }
  } catch {
    // Private browsing or blocked storage. The session still works for this
    // tab; it simply will not survive a reload.
  }
  for (const listener of listeners) listener(next);
}

export function storedRefreshToken(): string | null {
  try {
    return localStorage.getItem(REFRESH_STORAGE_KEY);
  } catch {
    return null;
  }
}

interface SessionResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  deviceId: string;
  userId: string;
}

export function adoptSession(response: SessionResponse): Session {
  const next: Session = {
    accessToken: response.accessToken,
    refreshToken: response.refreshToken,
    expiresAt: Date.now() + response.expiresIn * 1000,
    deviceId: response.deviceId,
    userId: response.userId,
  };
  setSession(next);
  return next;
}

export function clearSession(): void {
  setSession(null);
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  /** Skips the bearer token and the refresh dance. Used by public endpoints. */
  anonymous?: boolean;
  signal?: AbortSignal;
}

export async function request<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
  const token = options.anonymous ? null : await validAccessToken();
  const response = await fetch(path, {
    method: options.method ?? "GET",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal,
  });

  // One retry after a refresh: an access token can expire between the check
  // above and the server reading it.
  if (response.status === 401 && !options.anonymous && session) {
    const refreshed = await refreshSession().catch(() => null);
    if (refreshed) return await request<T>(path, options);
    clearSession();
  }

  return await unwrap<T>(response);
}

async function unwrap<T>(response: Response): Promise<T> {
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!response.ok) {
    const error = (body as ApiErrorBody | null)?.error;
    throw new ApiError(
      response.status,
      error?.code ?? "request_failed",
      error?.message ?? `The server returned ${response.status}`,
      error?.details,
    );
  }
  return body as T;
}

async function validAccessToken(): Promise<string | null> {
  if (!session) return null;
  if (session.expiresAt - REFRESH_MARGIN_MS > Date.now()) return session.accessToken;
  const refreshed = await refreshSession().catch(() => null);
  return refreshed?.accessToken ?? null;
}

/**
 * Rotates the refresh token.
 *
 * Collapsed into one in-flight promise: several components mounting at once
 * would otherwise each present the same token, and the server treats a second
 * use of a rotated token as compromise and revokes the device.
 */
export async function refreshSession(): Promise<Session> {
  if (refreshInFlight) return await refreshInFlight;
  const refreshToken = session?.refreshToken ?? storedRefreshToken();
  if (!refreshToken) throw new ApiError(401, "no_session", "Not signed in");

  refreshInFlight = (async () => {
    const response = await fetch("/v1/auth/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });
    const body = await unwrap<SessionResponse>(response);
    return adoptSession(body);
  })();

  try {
    return await refreshInFlight;
  } catch (error) {
    clearSession();
    throw error;
  } finally {
    refreshInFlight = null;
  }
}

export async function signOut(): Promise<void> {
  const refreshToken = session?.refreshToken;
  clearSession();
  if (!refreshToken) return;
  try {
    await fetch("/v1/auth/logout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });
  } catch {
    // The local session is already gone; a failed round trip only leaves a
    // refresh token that expires on its own.
  }
}

export const api = {
  get: <T>(path: string, options?: RequestOptions) => request<T>(path, { ...options, method: "GET" }),
  post: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>(path, { ...options, method: "POST", body }),
  put: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>(path, { ...options, method: "PUT", body }),
  patch: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>(path, { ...options, method: "PATCH", body }),
  delete: <T>(path: string, options?: RequestOptions) =>
    request<T>(path, { ...options, method: "DELETE" }),
};
