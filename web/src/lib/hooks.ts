import { useCallback, useEffect, useRef, useState } from "react";

import { ApiError } from "./api";
import { useI18n, type TranslationKey } from "./i18n";

export interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload(): void;
  setData(next: T | null): void;
}

/**
 * Loads data for a view.
 *
 * Every request is aborted when the effect is torn down and results from a
 * superseded load are dropped, so a fast click between pages cannot leave the
 * previous page's response in the new page's state.
 */
export function useAsync<T>(loader: (signal: AbortSignal) => Promise<T>, deps: unknown[] = []): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const { t } = useI18n();

  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setLoading(true);
    setError(null);

    void (async () => {
      try {
        const result = await loaderRef.current(controller.signal);
        if (active) setData(result);
      } catch (caught) {
        if (controller.signal.aborted || !active) return;
        setError(describeError(caught, t));
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => {
      active = false;
      controller.abort();
    };
    // The loader is held in a ref so it never has to be a dependency; `deps`
    // is what a caller declares the load actually varies on.
  }, [nonce, ...deps]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);
  return { data, loading, error, reload, setData };
}

/**
 * Turns an API error into something a person can act on.
 *
 * The handful of codes with a localized message get one; everything else falls
 * back to the server's own message, which is written to be read.
 */
const ERROR_MESSAGES: Record<string, TranslationKey> = {
  invalid_credentials: "error.invalidCredentials",
  too_many_attempts: "error.tooManyAttempts",
  account_disabled: "error.accountDisabled",
  invalid_mfa_code: "error.invalidMfaCode",
  invalid_token: "error.sessionExpired",
  device_revoked: "error.sessionExpired",
  not_found: "error.notFound",
  admin_required: "error.forbidden",
  personal_vault_required: "error.personalVaultRequired",
  owns_teams: "error.ownsTeams",
};

export function describeError(error: unknown, t: (key: TranslationKey) => string): string {
  if (error instanceof ApiError) {
    const key = ERROR_MESSAGES[error.code];
    return key ? t(key) : error.message;
  }
  if (error instanceof TypeError) return t("status.offline");
  if (error instanceof Error && error.message) return error.message;
  return t("common.unknownError");
}

/** Wraps a submit handler with pending state and a readable error. */
export function useAction() {
  const { t } = useI18n();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(
    async <T>(operation: () => Promise<T>): Promise<T | undefined> => {
      setPending(true);
      setError(null);
      setDone(false);
      try {
        const result = await operation();
        if (mounted.current) setDone(true);
        return result;
      } catch (caught) {
        if (mounted.current) setError(describeError(caught, t));
        return undefined;
      } finally {
        if (mounted.current) setPending(false);
      }
    },
    [t],
  );

  const reset = useCallback(() => {
    setError(null);
    setDone(false);
  }, []);

  return { run, pending, error, done, reset, setError };
}

/** Clears a transient confirmation after a moment. */
export function useTimedFlag(durationMs = 2500): [boolean, () => void] {
  const [flag, setFlag] = useState(false);
  useEffect(() => {
    if (!flag) return;
    const timer = setTimeout(() => setFlag(false), durationMs);
    return () => clearTimeout(timer);
  }, [flag, durationMs]);
  return [flag, useCallback(() => setFlag(true), [])];
}

export function useDocumentTitle(title: string, serverName?: string): void {
  useEffect(() => {
    document.title = serverName ? `${title} · ${serverName}` : title;
  }, [title, serverName]);
}
