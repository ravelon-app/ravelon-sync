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
const REFRESH_LOCK_NAME = "ravelon-sync.refresh";
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
  return readStoredRefreshToken().token;
}

/**
 * Reads the shared refresh token, telling "nothing stored" apart from
 * "storage unavailable". Only the second may fall back to the copy in memory;
 * an empty slot means another tab signed out.
 */
function readStoredRefreshToken(): { available: boolean; token: string | null } {
  try {
    return { available: true, token: localStorage.getItem(REFRESH_STORAGE_KEY) };
  } catch {
    return { available: false, token: null };
  }
}

/**
 * Follows the refresh token another tab of this origin wrote.
 *
 * Every tab of one browser shares a single refresh token chain. Without this,
 * a tab would keep presenting a token another tab already rotated, and the
 * server treats that replay as theft and signs the device out.
 */
export function applyStoredRefreshToken(token: string | null): void {
  if (token === null) {
    if (!session) return;
    // Signed out in another tab. The server already revoked the token, so
    // this tab ends its session too instead of failing on the next request.
    session = null;
    for (const listener of listeners) listener(null);
    return;
  }
  if (session && session.refreshToken !== token) {
    session = { ...session, refreshToken: token };
  }
}

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("storage", (event: StorageEvent) => {
    // A null key means another tab cleared all of storage.
    if (event.key !== null && event.key !== REFRESH_STORAGE_KEY) return;
    applyStoredRefreshToken(event.key === null ? null : event.newValue);
  });
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

/** Codes that mean only the access token is stale, which one refresh can fix. */
const RETRYABLE_AUTH_CODES = new Set(["invalid_token", "unauthorized"]);

export async function request<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
  return await send<T>(path, options, true);
}

async function send<T>(path: string, options: RequestOptions, mayRetry: boolean): Promise<T> {
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
  // above and the server reading it. Only for an expired or invalid token, and
  // only once: a wrong password on a reauthentication route also answers 401,
  // and resending it would count every typo twice against the lockout.
  if (response.status === 401 && !options.anonymous && session && mayRetry) {
    const code = await errorCode(response.clone());
    if (code && RETRYABLE_AUTH_CODES.has(code)) {
      const refreshed = await refreshSession().catch(() => null);
      if (refreshed) return await send<T>(path, options, false);
      clearSession();
    } else if (code === "device_revoked") {
      clearSession();
    }
  }

  return await unwrap<T>(response);
}

async function unwrap<T>(response: Response): Promise<T> {
  // null, not undefined: useAction reports a failure as undefined, so a
  // successful 204 (delete, sign out a device) would read as one and leave the
  // dialog open with the list unchanged.
  if (response.status === 204) return null as T;
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

async function errorCode(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as ApiErrorBody | null;
    return body?.error?.code ?? null;
  } catch {
    return null;
  }
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
 * Collapsed into one in-flight promise per tab: several components mounting
 * at once would otherwise each present the same token, and the server treats
 * a second use of a rotated token as compromise and revokes the device.
 * Across tabs the rotation runs under a Web Lock and always starts from the
 * token in storage, because another tab may have rotated it a moment ago and
 * the copy in this tab's memory would then be a replay.
 */
export function refreshSession(): Promise<Session> {
  if (refreshInFlight) return refreshInFlight;
  const inFlight = withRefreshLock(rotateStoredToken).finally(() => {
    if (refreshInFlight === inFlight) refreshInFlight = null;
  });
  refreshInFlight = inFlight;
  return inFlight;
}

async function rotateStoredToken(): Promise<Session> {
  const stored = readStoredRefreshToken();
  const refreshToken = stored.available ? stored.token : session?.refreshToken ?? null;
  if (!refreshToken) {
    if (session) {
      session = null;
      for (const listener of listeners) listener(null);
    }
    throw new ApiError(401, "no_session", "Not signed in");
  }

  // A network failure throws here, before the catch below: it says nothing
  // about the token, so the session is kept for the next attempt rather than
  // signing every tab out.
  const response = await fetch("/v1/auth/refresh", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refreshToken }),
  });
  try {
    return adoptSession(await unwrap<SessionResponse>(response));
  } catch (error) {
    // Only drop the stored token while it is still the one that was refused.
    // If another tab replaced it in the meantime, that newer session stays.
    if (!stored.available || readStoredRefreshToken().token === refreshToken) clearSession();
    throw error;
  }
}

interface LockManagerLike {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

function withRefreshLock<T>(operation: () => Promise<T>): Promise<T> {
  const locks = (globalThis.navigator as { locks?: LockManagerLike } | undefined)?.locks;
  if (!locks || typeof locks.request !== "function") return operation();
  return locks.request(REFRESH_LOCK_NAME, operation);
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
