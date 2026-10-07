/** Only a path on this site: "//host" or "https://..." would be an open redirect. */
export function safeNext(next: string | null | undefined): string {
  return next?.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : "/";
}

/** The token of a team invitation link, when `next` points at one. */
export function teamTokenFromNext(next: string | null | undefined): string | null {
  const path = safeNext(next);
  if (!path.startsWith("/invite/team?")) return null;
  return new URLSearchParams(path.slice("/invite/team?".length)).get("token");
}
