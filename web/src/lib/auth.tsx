import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import {
  adoptSession,
  api,
  ApiError,
  clearSession,
  getSession,
  onSessionChange,
  refreshSession,
  signOut as apiSignOut,
  storedRefreshToken,
} from "./api";
import type { AccountBundle, PublicConfig } from "./types";

interface SessionResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  deviceId: string;
  userId: string;
}

export interface MfaChallenge {
  challengeToken: string;
  expiresAt: string;
}

export type SignInResult =
  | { state: "complete" }
  | { state: "mfaRequired"; challenge: MfaChallenge };

interface AuthValue {
  /** Null until the first load settles, so nothing renders against a guess. */
  ready: boolean;
  config: PublicConfig | null;
  account: AccountBundle | null;
  signedIn: boolean;
  signIn(email: string, password: string): Promise<SignInResult>;
  verifyMfa(challengeToken: string, code: string): Promise<void>;
  signUp(input: { email: string; password: string; displayName?: string; inviteToken?: string }): Promise<void>;
  signOut(): Promise<void>;
  reloadAccount(): Promise<void>;
  reloadConfig(): Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

/** What a browser session identifies itself as in the device list. */
function deviceName(): string {
  const agent = navigator.userAgent;
  if (/Firefox\//.test(agent)) return "Firefox";
  if (/Edg\//.test(agent)) return "Edge";
  if (/Chrome\//.test(agent)) return "Chrome";
  if (/Safari\//.test(agent)) return "Safari";
  return "Browser";
}

const CLIENT_INFO = { deviceName: deviceName(), platform: "web", mfaSupported: true };

export function AuthProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [account, setAccount] = useState<AccountBundle | null>(null);

  const reloadConfig = useCallback(async () => {
    try {
      setConfig(await api.get<PublicConfig>("/v1/public-config", { anonymous: true }));
    } catch {
      // The server may be starting or unreachable. The shell renders an
      // offline notice rather than a blank page.
      setConfig(null);
    }
  }, []);

  const reloadAccount = useCallback(async () => {
    if (!getSession()) {
      setAccount(null);
      return;
    }
    try {
      setAccount(await api.get<AccountBundle>("/v1/account/me"));
    } catch (error) {
      // A disabled or deleted account still holds a refresh token locally.
      // Dropping it here is what turns that into a clean sign-out.
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
        clearSession();
        setAccount(null);
        return;
      }
      throw error;
    }
  }, []);

  // A session can end outside this component: another tab signing out, or a
  // refresh the server refused. The interface follows instead of showing an
  // account whose requests will all fail.
  useEffect(
    () =>
      onSessionChange((next) => {
        if (!next) setAccount(null);
      }),
    [],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await reloadConfig();
      if (storedRefreshToken()) {
        // A stored refresh token is the only thing that survives a reload, so
        // restoring a session always starts with rotating it.
        await refreshSession().catch(() => null);
        if (!cancelled) await reloadAccount().catch(() => null);
      }
      if (!cancelled) setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadAccount, reloadConfig]);

  const signIn = useCallback<AuthValue["signIn"]>(
    async (email, password) => {
      const response = await api.post<SessionResponse | { mfaRequired: true; challengeToken: string; expiresAt: string }>(
        "/v1/auth/login",
        { email, password, ...CLIENT_INFO },
        { anonymous: true },
      );
      if ("mfaRequired" in response && response.mfaRequired) {
        return {
          state: "mfaRequired",
          challenge: { challengeToken: response.challengeToken, expiresAt: response.expiresAt },
        };
      }
      adoptSession(response as SessionResponse);
      await reloadAccount();
      return { state: "complete" };
    },
    [reloadAccount],
  );

  const verifyMfa = useCallback<AuthValue["verifyMfa"]>(
    async (challengeToken, code) => {
      const response = await api.post<SessionResponse>(
        "/v1/auth/mfa/verify",
        { challengeToken, code },
        { anonymous: true },
      );
      adoptSession(response);
      await reloadAccount();
    },
    [reloadAccount],
  );

  const signUp = useCallback<AuthValue["signUp"]>(
    async (input) => {
      const response = await api.post<SessionResponse>(
        "/v1/auth/register",
        { ...input, ...CLIENT_INFO },
        { anonymous: true },
      );
      adoptSession(response);
      await Promise.all([reloadAccount(), reloadConfig()]);
    },
    [reloadAccount, reloadConfig],
  );

  const signOut = useCallback(async () => {
    await apiSignOut();
    setAccount(null);
  }, []);

  const value = useMemo<AuthValue>(
    () => ({
      ready,
      config,
      account,
      signedIn: Boolean(account),
      signIn,
      verifyMfa,
      signUp,
      signOut,
      reloadAccount,
      reloadConfig,
    }),
    [ready, config, account, signIn, verifyMfa, signUp, signOut, reloadAccount, reloadConfig],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside AuthProvider");
  return context;
}

/** Convenience for views that only render when signed in. */
export function useAccount(): AccountBundle {
  const { account } = useAuth();
  if (!account) throw new Error("useAccount used outside an authenticated route");
  return account;
}
