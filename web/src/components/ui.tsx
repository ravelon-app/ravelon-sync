import {
  forwardRef,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { AlertTriangle, Check, Copy, Info, Loader2, X } from "lucide-react";

import { useI18n } from "../lib/i18n";

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/* --- surfaces ------------------------------------------------------------ */

export function Panel({
  children,
  className,
  ...rest
}: { children: ReactNode; className?: string } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cx("panel", className)} {...rest}>
      {children}
    </div>
  );
}

export function PanelHeader({
  title,
  description,
  action,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-line-soft px-5 py-4">
      <div className="min-w-0">
        <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-fg">{title}</h2>
        {description ? <p className="mt-1 text-[13px] leading-relaxed text-fg2">{description}</p> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

export function PageHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-[-0.02em] text-fg">{title}</h1>
        {description ? <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-fg2">{description}</p> : null}
      </div>
      {action}
    </header>
  );
}

/* --- buttons ------------------------------------------------------------- */

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: "sm" | "md";
  loading?: boolean;
  icon?: ReactNode;
}

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  // The accent is the one loud thing on a page, so it marks the single action
  // a view exists for and nothing else.
  primary:
    "bg-teal text-ink hover:bg-teal-deep active:bg-teal-deep disabled:bg-teal/40 disabled:text-ink/60 font-semibold",
  secondary:
    "bg-raised text-fg border border-line hover:border-fg3/60 hover:bg-raised/70 disabled:text-fg3",
  ghost: "text-fg2 hover:text-fg hover:bg-raised/70 disabled:text-fg3",
  danger:
    "bg-transparent text-danger border border-danger/40 hover:bg-danger/10 hover:border-danger/70 disabled:opacity-50",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", loading, icon, children, className, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      disabled={disabled || loading}
      className={cx(
        "inline-flex items-center justify-center gap-2 rounded-lg transition-colors duration-150",
        "disabled:cursor-not-allowed",
        size === "sm" ? "h-8 px-3 text-[13px]" : "h-10 px-4 text-sm",
        BUTTON_VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin-slow" aria-hidden /> : icon}
      {children}
    </button>
  );
});

/* --- form fields --------------------------------------------------------- */

export function Field({
  label,
  hint,
  error,
  children,
  htmlFor,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-[13px] font-medium text-fg">
        {label}
      </label>
      {children}
      {error ? (
        <p className="text-[12.5px] text-danger" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="text-[12.5px] leading-relaxed text-fg3">{hint}</p>
      ) : null}
    </div>
  );
}

const CONTROL_CLASS =
  "w-full rounded-lg border border-line bg-raised px-3 text-sm text-fg placeholder:text-fg3 " +
  "transition-colors duration-150 hover:border-fg3/50 focus:border-teal focus:outline-none " +
  "focus:ring-2 focus:ring-teal/25 disabled:cursor-not-allowed disabled:opacity-60";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...rest }, ref) {
    return <input ref={ref} className={cx(CONTROL_CLASS, "h-10", className)} {...rest} />;
  },
);

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...rest }, ref) {
    return <textarea ref={ref} className={cx(CONTROL_CLASS, "min-h-24 py-2.5", className)} {...rest} />;
  },
);

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, children, ...rest }, ref) {
    return (
      <select ref={ref} className={cx(CONTROL_CLASS, "h-10 pr-8", className)} {...rest}>
        {children}
      </select>
    );
  },
);

export function Toggle({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean;
  onChange(next: boolean): void;
  label: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex items-start gap-3">
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cx(
          "mt-0.5 h-5 w-9 shrink-0 rounded-full border transition-colors duration-150",
          "disabled:cursor-not-allowed disabled:opacity-50",
          checked ? "border-teal bg-teal" : "border-line bg-raised",
        )}
      >
        <span
          className={cx(
            "block h-3.5 w-3.5 rounded-full transition-transform duration-150",
            checked ? "translate-x-[19px] bg-ink" : "translate-x-[3px] bg-fg3",
          )}
        />
      </button>
      <label htmlFor={id} className="cursor-pointer select-none">
        <span className="block text-[13px] font-medium text-fg">{label}</span>
        {hint ? <span className="mt-0.5 block text-[12.5px] leading-relaxed text-fg3">{hint}</span> : null}
      </label>
    </div>
  );
}

/* --- feedback ------------------------------------------------------------ */

type NoticeTone = "info" | "warn" | "danger" | "ok";

const NOTICE_TONES: Record<NoticeTone, { wrap: string; icon: ReactNode }> = {
  info: { wrap: "border-line bg-raised/60 text-fg2", icon: <Info className="h-4 w-4 text-fg3" /> },
  ok: { wrap: "border-ok/30 bg-ok/8 text-fg2", icon: <Check className="h-4 w-4 text-ok" /> },
  warn: {
    wrap: "border-warn/35 bg-warn/8 text-fg2",
    icon: <AlertTriangle className="h-4 w-4 text-warn" />,
  },
  danger: {
    wrap: "border-danger/40 bg-danger/8 text-fg2",
    icon: <AlertTriangle className="h-4 w-4 text-danger" />,
  },
};

export function Notice({
  tone = "info",
  title,
  children,
  className,
}: {
  tone?: NoticeTone;
  title?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  const style = NOTICE_TONES[tone];
  return (
    <div
      className={cx("flex gap-3 rounded-lg border px-4 py-3 text-[13px] leading-relaxed", style.wrap, className)}
      role={tone === "danger" ? "alert" : undefined}
    >
      <span className="mt-0.5 shrink-0">{style.icon}</span>
      <div className="min-w-0">
        {title ? <p className="font-medium text-fg">{title}</p> : null}
        {children ? <div className={title ? "mt-1" : undefined}>{children}</div> : null}
      </div>
    </div>
  );
}

type BadgeTone = "neutral" | "accent" | "warn" | "danger" | "ok";

const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: "border-line bg-raised text-fg2",
  accent: "border-teal/40 bg-teal/10 text-teal",
  warn: "border-warn/40 bg-warn/10 text-warn",
  danger: "border-danger/40 bg-danger/10 text-danger",
  ok: "border-ok/40 bg-ok/10 text-ok",
};

export function Badge({
  tone = "neutral",
  children,
  className,
}: {
  tone?: BadgeTone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cx(
        "inline-flex items-center rounded-md border px-2 py-0.5 text-[11.5px] font-medium",
        BADGE_TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Spinner({ className }: { className?: string }) {
  const { t } = useI18n();
  return (
    <span role="status" aria-label={t("common.loading")} className={cx("inline-flex", className)}>
      <Loader2 className="h-4 w-4 animate-spin-slow text-fg3" aria-hidden />
    </span>
  );
}

export function LoadingBlock() {
  return (
    <div className="flex items-center justify-center py-16">
      <Spinner />
    </div>
  );
}

export function EmptyState({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-14 text-center">
      {icon ? <div className="text-fg3">{icon}</div> : null}
      <p className="text-sm font-medium text-fg">{title}</p>
      {children ? <div className="max-w-sm text-[13px] leading-relaxed text-fg3">{children}</div> : null}
    </div>
  );
}

/* --- copyable values ----------------------------------------------------- */

export function CopyField({ value, label }: { value: string; label?: ReactNode }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      // Clipboard access can be refused. The value is on screen and
      // selectable, so there is still a way to get it.
    }
  };

  return (
    <div className="space-y-1.5">
      {label ? <p className="label-caps">{label}</p> : null}
      <div className="flex items-stretch gap-2">
        <code className="min-w-0 flex-1 overflow-x-auto rounded-lg border border-line bg-ink px-3 py-2.5 font-mono text-[12.5px] whitespace-nowrap text-fg2">
          {value}
        </code>
        <Button
          size="md"
          onClick={copy}
          icon={copied ? <Check className="h-4 w-4 text-ok" /> : <Copy className="h-4 w-4" />}
          aria-label={t("common.copy")}
        >
          {copied ? t("common.copied") : t("common.copy")}
        </Button>
      </div>
    </div>
  );
}

/* --- dialog -------------------------------------------------------------- */

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  tone = "neutral",
}: {
  open: boolean;
  onClose(): void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  tone?: "neutral" | "danger";
}) {
  const { t } = useI18n();
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    // Focus moves into the dialog so a keyboard user is not left behind on the
    // page underneath.
    const focusable = panelRef.current?.querySelector<HTMLElement>(
      "input, select, textarea, button:not([disabled])",
    );
    focusable?.focus();
    const { overflow } = document.body.style;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = overflow;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-ink/80 backdrop-blur-[2px] animate-fade"
        onClick={onClose}
        aria-hidden
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        className="panel animate-rise relative z-10 w-full max-w-lg shadow-2xl shadow-black/40"
      >
        <div className="flex items-start justify-between gap-4 border-b border-line-soft px-5 py-4">
          <div className="min-w-0">
            <h2 className={cx("text-[15px] font-semibold", tone === "danger" ? "text-danger" : "text-fg")}>
              {title}
            </h2>
            {description ? (
              <p className="mt-1.5 text-[13px] leading-relaxed text-fg2">{description}</p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("common.close")}
            className="-mr-1 -mt-1 rounded-md p-1.5 text-fg3 transition-colors hover:bg-raised hover:text-fg"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        {children ? <div className="px-5 py-4">{children}</div> : null}
        {footer ? (
          <div className="flex justify-end gap-2 border-t border-line-soft px-5 py-3.5">{footer}</div>
        ) : null}
      </div>
    </div>
  );
}

/* --- data display -------------------------------------------------------- */

export function DataList({ rows }: { rows: Array<{ label: ReactNode; value: ReactNode }> }) {
  return (
    <dl className="divide-y divide-line-soft">
      {rows.map((row, index) => (
        <div key={index} className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 px-5 py-3">
          <dt className="text-[13px] text-fg2">{row.label}</dt>
          <dd className="text-[13px] font-medium text-fg">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="panel px-5 py-4">
      <p className="label-caps">{label}</p>
      <p className="mt-2 font-mono text-2xl tracking-[-0.02em] text-fg tabular-nums">{value}</p>
      {hint ? <p className="mt-1 text-[12.5px] text-fg3">{hint}</p> : null}
    </div>
  );
}

/**
 * A horizontally scrollable table.
 *
 * Wide tables scroll inside their own container so the page body never scrolls
 * sideways on a narrow screen.
 */
export function TableWrap({ children }: { children: ReactNode }) {
  return <div className="overflow-x-auto">{children}</div>;
}

export function Th({ children, className }: { children?: ReactNode; className?: string }) {
  return (
    <th
      scope="col"
      className={cx(
        "whitespace-nowrap px-5 py-2.5 text-left text-[11px] font-semibold uppercase tracking-[0.09em] text-fg3",
        className,
      )}
    >
      {children}
    </th>
  );
}

export function Td({ children, className }: { children?: ReactNode; className?: string }) {
  return <td className={cx("px-5 py-3 text-[13px] text-fg2", className)}>{children}</td>;
}
