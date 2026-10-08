import { cx } from "./ui";

/**
 * The server's name, next to a mark.
 *
 * The name is whatever the operator set, so it is the changeable half; the
 * mark stays fixed and is what makes a Ravelon Sync deployment recognisable
 * regardless of what it was named.
 */
export function Wordmark({ name, compact, large }: { name: string; compact?: boolean; large?: boolean }) {
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      <Mark className={large ? "h-8 w-8" : "h-6 w-6"} />
      <span className="min-w-0">
        <span
          className={cx(
            "block truncate font-semibold tracking-[-0.01em] text-fg",
            large ? "text-lg" : "text-[14px]",
          )}
        >
          {name}
        </span>
        {!compact && !large ? (
          <span className="block text-[10.5px] font-medium uppercase tracking-[0.11em] text-fg3">
            Ravelon Sync
          </span>
        ) : null}
      </span>
    </span>
  );
}

function Mark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cx("shrink-0", className)} aria-hidden focusable="false">
      <rect x="0.75" y="0.75" width="30.5" height="30.5" rx="7.25" fill="rgb(23 35 46)" />
      <rect
        x="0.75"
        y="0.75"
        width="30.5"
        height="30.5"
        rx="7.25"
        fill="none"
        stroke="rgb(38 52 66)"
        strokeWidth="1.5"
      />
      <path
        d="M10 22V10h6.4a3.8 3.8 0 0 1 1.2 7.4L21 22h-3.3l-3-4.2H12.8V22H10Zm2.8-6.6h3.4a1.6 1.6 0 0 0 0-3.2h-3.4v3.2Z"
        fill="rgb(22 214 199)"
      />
    </svg>
  );
}
