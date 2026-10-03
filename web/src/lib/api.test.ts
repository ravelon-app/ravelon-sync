import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * The refresh token chain is shared by every tab of one browser. These tests
 * pin the behaviour that keeps two tabs from replaying each other's rotated
 * tokens, which the server answers by signing the device out.
 */

const STORAGE_KEY = "ravelon-sync.refresh";

class MemoryStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
}

function sessionResponse(refreshToken: string, accessToken = `access-${refreshToken}`) {
  return new Response(
    JSON.stringify({ accessToken, refreshToken, expiresIn: 900, deviceId: "device", userId: "user" }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function errorResponse(status: number, code: string) {
  return new Response(JSON.stringify({ error: { code, message: code } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let storage: MemoryStorage;
let fetchMock: ReturnType<typeof vi.fn>;

async function loadApi() {
  vi.resetModules();
  return await import("./api");
}

function refreshBodies(): string[] {
  return fetchMock.mock.calls
    .filter(([url]) => url === "/v1/auth/refresh")
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)).refreshToken as string);
}

beforeEach(() => {
  storage = new MemoryStorage();
  fetchMock = vi.fn();
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("refreshSession", () => {
  test("uses the token another tab stored rather than the stale copy in memory", async () => {
    const api = await loadApi();
    api.adoptSession({ accessToken: "a1", refreshToken: "rft_tab_a", expiresIn: 900, deviceId: "d", userId: "u" });
    // Another tab rotated the shared token after this tab read it.
    storage.setItem(STORAGE_KEY, "rft_rotated_by_tab_b");
    fetchMock.mockResolvedValueOnce(sessionResponse("rft_next"));

    const session = await api.refreshSession();

    expect(refreshBodies()).toEqual(["rft_rotated_by_tab_b"]);
    expect(session.refreshToken).toBe("rft_next");
    expect(storage.getItem(STORAGE_KEY)).toBe("rft_next");
  });

  test("runs one refresh at a time per tab", async () => {
    const api = await loadApi();
    storage.setItem(STORAGE_KEY, "rft_only");
    let release!: (response: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => {
      release = resolve;
    }));

    const first = api.refreshSession();
    const second = api.refreshSession();
    expect(second).toBe(first);
    // Let the refresh reach fetch before answering it.
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    release(sessionResponse("rft_after"));
    await Promise.all([first, second]);

    expect(refreshBodies()).toEqual(["rft_only"]);
  });

  test("serialises refreshes across tabs through a Web Lock", async () => {
    const order: string[] = [];
    const locks = {
      request: vi.fn(async (name: string, callback: () => Promise<unknown>) => {
        order.push(`lock:${name}`);
        return await callback();
      }),
    };
    vi.stubGlobal("navigator", { locks });
    const api = await loadApi();
    storage.setItem(STORAGE_KEY, "rft_locked");
    fetchMock.mockResolvedValueOnce(sessionResponse("rft_locked_next"));

    await api.refreshSession();

    expect(locks.request).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["lock:ravelon-sync.refresh"]);
  });

  test("does not sign out when a refresh fails on the network", async () => {
    const api = await loadApi();
    api.adoptSession({ accessToken: "a", refreshToken: "rft_keep", expiresIn: 900, deviceId: "d", userId: "u" });
    fetchMock.mockRejectedValueOnce(new TypeError("offline"));

    await expect(api.refreshSession()).rejects.toThrow("offline");
    expect(storage.getItem(STORAGE_KEY)).toBe("rft_keep");
    expect(api.getSession()).not.toBeNull();
  });

  test("a refused refresh leaves a newer token from another tab in place", async () => {
    const api = await loadApi();
    storage.setItem(STORAGE_KEY, "rft_old");
    fetchMock.mockImplementationOnce(async () => {
      // Another tab signs in again while this request is in flight.
      storage.setItem(STORAGE_KEY, "rft_from_other_tab");
      return errorResponse(401, "invalid_refresh_token");
    });

    await expect(api.refreshSession()).rejects.toMatchObject({ code: "invalid_refresh_token" });
    expect(storage.getItem(STORAGE_KEY)).toBe("rft_from_other_tab");
  });
});

describe("applyStoredRefreshToken", () => {
  test("follows a rotation made in another tab", async () => {
    const api = await loadApi();
    api.adoptSession({ accessToken: "a", refreshToken: "rft_1", expiresIn: 900, deviceId: "d", userId: "u" });

    api.applyStoredRefreshToken("rft_2");

    expect(api.getSession()?.refreshToken).toBe("rft_2");
    expect(api.getSession()?.accessToken).toBe("a");
  });

  test("ends this tab's session when another tab signs out", async () => {
    const api = await loadApi();
    api.adoptSession({ accessToken: "a", refreshToken: "rft_1", expiresIn: 900, deviceId: "d", userId: "u" });
    const seen: unknown[] = [];
    api.onSessionChange((next) => seen.push(next));

    api.applyStoredRefreshToken(null);

    expect(api.getSession()).toBeNull();
    expect(seen).toEqual([null]);
  });
});

describe("request", () => {
  test("retries once after refreshing an expired access token", async () => {
    const api = await loadApi();
    api.adoptSession({ accessToken: "old", refreshToken: "rft_1", expiresIn: 900, deviceId: "d", userId: "u" });
    fetchMock
      .mockResolvedValueOnce(errorResponse(401, "invalid_token"))
      .mockResolvedValueOnce(sessionResponse("rft_2", "new"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    await expect(api.request("/v1/account/me")).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  test("does not resend a wrong password after a 401", async () => {
    const api = await loadApi();
    api.adoptSession({ accessToken: "a", refreshToken: "rft_1", expiresIn: 900, deviceId: "d", userId: "u" });
    fetchMock.mockResolvedValue(errorResponse(401, "invalid_credentials"));

    await expect(api.request("/v1/account", { method: "DELETE", body: { password: "typo" } }))
      .rejects.toMatchObject({ code: "invalid_credentials" });
    // One request, no refresh and no resend that would count the typo twice.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(api.getSession()).not.toBeNull();
  });

  test("gives up after one retry when the token keeps being refused", async () => {
    const api = await loadApi();
    api.adoptSession({ accessToken: "a", refreshToken: "rft_1", expiresIn: 900, deviceId: "d", userId: "u" });
    fetchMock.mockImplementation(async (url: string) =>
      url === "/v1/auth/refresh" ? sessionResponse(`rft_${fetchMock.mock.calls.length}`) : errorResponse(401, "invalid_token"),
    );

    await expect(api.request("/v1/account/me")).rejects.toMatchObject({ code: "invalid_token" });
    expect(refreshBodies()).toHaveLength(1);
  });
});

describe("empty responses", () => {
  test("a 204 resolves to null, which useAction does not mistake for a failure", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const { request } = await loadApi();
    await expect(request("/v1/vaults/v1", { method: "DELETE", anonymous: true })).resolves.toBeNull();
  });
});
