import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { en } from "../locales/en";

/**
 * Every visible string goes through `t()`.
 *
 * English is the only locale that ships, but nothing in a component knows
 * that: adding a language means adding one file to `locales/` and listing it
 * below, without touching a single component.
 */
export type TranslationKey = keyof typeof en;
export type Translations = Record<TranslationKey, string>;

const LOCALES: Record<string, { label: string; strings: Partial<Translations> }> = {
  en: { label: "English", strings: en },
};

const STORAGE_KEY = "ravelon-sync.locale";

interface I18nValue {
  locale: string;
  locales: Array<{ code: string; label: string }>;
  setLocale(locale: string): void;
  t(key: TranslationKey, values?: Record<string, string | number>): string;
}

const I18nContext = createContext<I18nValue | null>(null);

function detectLocale(): string {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && stored in LOCALES) return stored;
  } catch {
    // Storage blocked; fall through to the browser's preference.
  }
  for (const candidate of navigator.languages ?? []) {
    const base = candidate.split("-")[0];
    if (base in LOCALES) return base;
  }
  return "en";
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<string>(() => detectLocale());

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const setLocale = useCallback((next: string) => {
    if (!(next in LOCALES)) return;
    setLocaleState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // The choice simply will not survive a reload.
    }
  }, []);

  const t = useCallback(
    (key: TranslationKey, values?: Record<string, string | number>) => {
      // English backs every lookup, so a partially translated locale shows
      // real text rather than a raw key.
      const template = LOCALES[locale]?.strings[key] ?? en[key] ?? key;
      if (!values) return template;
      return template.replace(/\{(\w+)\}/g, (match, name: string) =>
        name in values ? String(values[name]) : match,
      );
    },
    [locale],
  );

  const value = useMemo<I18nValue>(
    () => ({
      locale,
      locales: Object.entries(LOCALES).map(([code, entry]) => ({ code, label: entry.label })),
      setLocale,
      t,
    }),
    [locale, setLocale, t],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const context = useContext(I18nContext);
  if (!context) throw new Error("useI18n must be used inside I18nProvider");
  return context;
}
