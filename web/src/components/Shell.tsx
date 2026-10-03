import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import {
  Activity,
  ChevronDown,
  Database,
  KeyRound,
  LayoutGrid,
  LogOut,
  Menu,
  Monitor,
  ScrollText,
  Settings,
  Shield,
  Ticket,
  Users,
  UserCircle,
  X,
} from "lucide-react";

import { useAuth } from "../lib/auth";
import { useI18n } from "../lib/i18n";
import { initials, personLabel } from "../lib/format";
import { Badge, Button, cx, Notice } from "./ui";
import { Wordmark } from "./Wordmark";

interface NavItem {
  to: string;
  labelKey: Parameters<ReturnType<typeof useI18n>["t"]>[0];
  icon: typeof LayoutGrid;
  end?: boolean;
}

const PRIMARY_NAV: NavItem[] = [
  { to: "/", labelKey: "nav.overview", icon: LayoutGrid, end: true },
  { to: "/vaults", labelKey: "nav.vaults", icon: Database },
  { to: "/teams", labelKey: "nav.teams", icon: Users },
  { to: "/devices", labelKey: "nav.devices", icon: Monitor },
];

const ACCOUNT_NAV: NavItem[] = [
  { to: "/account", labelKey: "nav.account", icon: UserCircle },
  { to: "/security", labelKey: "nav.security", icon: KeyRound },
];

const ADMIN_NAV: NavItem[] = [
  { to: "/admin", labelKey: "nav.adminUsers", icon: Users, end: true },
  { to: "/admin/invites", labelKey: "nav.adminInvites", icon: Ticket },
  { to: "/admin/vaults", labelKey: "nav.adminVaults", icon: Database },
  { to: "/admin/audit", labelKey: "nav.adminAudit", icon: ScrollText },
  { to: "/admin/settings", labelKey: "nav.adminSettings", icon: Settings },
  { to: "/admin/system", labelKey: "nav.adminSystem", icon: Activity },
];

export function Shell() {
  const { t } = useI18n();
  const { account, config, signOut } = useAuth();
  const location = useLocation();
  const [navOpen, setNavOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  // A route change on a phone should close the drawer, not leave it covering
  // the page the person just navigated to.
  useEffect(() => {
    setNavOpen(false);
    setMenuOpen(false);
  }, [location.pathname]);

  if (!account) return null;
  const isAdmin = account.user.role === "admin";

  return (
    <div className="flex min-h-full">
      {navOpen ? (
        <div
          className="fixed inset-0 z-30 bg-ink/70 backdrop-blur-[2px] lg:hidden"
          onClick={() => setNavOpen(false)}
          aria-hidden
        />
      ) : null}

      <aside
        className={cx(
          "fixed inset-y-0 left-0 z-40 flex w-64 shrink-0 flex-col border-r border-line bg-surface",
          "transition-transform duration-200 lg:static lg:translate-x-0",
          navOpen ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="flex h-14 items-center justify-between gap-2 border-b border-line px-5">
          <Wordmark name={config?.serverName ?? account.deployment.serverName} />
          <button
            type="button"
            className="rounded-md p-1.5 text-fg3 hover:bg-raised hover:text-fg lg:hidden"
            onClick={() => setNavOpen(false)}
            aria-label={t("common.close")}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 py-4">
          <NavGroup items={PRIMARY_NAV} />
          <NavGroup items={ACCOUNT_NAV} className="mt-6" heading={t("nav.account")} />
          {isAdmin ? <NavGroup items={ADMIN_NAV} className="mt-6" heading={t("nav.admin")} /> : null}
        </nav>

        <div className="border-t border-line p-3">
          <div className="relative">
            <button
              type="button"
              onClick={() => setMenuOpen((open) => !open)}
              aria-expanded={menuOpen}
              className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-raised"
            >
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-line bg-raised font-mono text-[11px] font-semibold text-teal">
                {initials(account.user)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium text-fg">
                  {personLabel(account.user)}
                </span>
                <span className="block truncate text-[11.5px] text-fg3">
                  {isAdmin ? t("admin.roleAdmin") : account.user.email}
                </span>
              </span>
              <ChevronDown
                className={cx("h-4 w-4 shrink-0 text-fg3 transition-transform", menuOpen && "rotate-180")}
              />
            </button>

            {menuOpen ? (
              <div className="panel animate-rise absolute bottom-full left-0 mb-2 w-full overflow-hidden p-1 shadow-xl shadow-black/40">
                <button
                  type="button"
                  onClick={() => void signOut()}
                  className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-[13px] text-fg2 transition-colors hover:bg-raised hover:text-fg"
                >
                  <LogOut className="h-4 w-4" />
                  {t("auth.signOut")}
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center gap-3 border-b border-line px-4 lg:hidden">
          <button
            type="button"
            className="rounded-md p-2 text-fg2 hover:bg-raised hover:text-fg"
            onClick={() => setNavOpen(true)}
            aria-label={t("nav.overview")}
          >
            <Menu className="h-5 w-5" />
          </button>
          <Wordmark name={config?.serverName ?? account.deployment.serverName} compact />
        </header>

        <main className="flex-1 px-5 py-6 sm:px-8 sm:py-8">
          <div className="mx-auto w-full max-w-6xl">
            {config?.maintenanceMode ? (
              <Notice tone="warn" className="mb-6" title={t("status.maintenance")}>
                {config.maintenanceMessage || null}
              </Notice>
            ) : null}
            {/* canSync is the server's effective policy, which also covers
                domain sign-up, not only the explicit setting. */}
            {!account.entitlements.canSync && !account.user.emailVerified ? (
              <Notice tone="warn" className="mb-6">
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  {t("overview.securityEmailUnverified")}
                  <NavLink to="/account" className="font-medium text-teal underline-offset-2 hover:underline">
                    {t("account.resendVerification")}
                  </NavLink>
                </span>
              </Notice>
            ) : null}
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}

function NavGroup({
  items,
  heading,
  className,
}: {
  items: NavItem[];
  heading?: string;
  className?: string;
}) {
  const { t } = useI18n();
  return (
    <div className={className}>
      {heading ? <p className="label-caps mb-2 px-3">{heading}</p> : null}
      <ul className="space-y-0.5">
        {items.map((item) => (
          <li key={item.to}>
            <NavLink
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                cx(
                  "flex items-center gap-3 rounded-lg px-3 py-2 text-[13px] transition-colors duration-150",
                  isActive
                    ? // The accent bar is the only place the teal appears in
                      // navigation, so the current page reads at a glance.
                      "bg-raised font-medium text-fg shadow-[inset_2px_0_0_0_var(--color-teal)]"
                    : "text-fg2 hover:bg-raised/60 hover:text-fg",
                )
              }
            >
              <item.icon className="h-4 w-4 shrink-0" />
              {t(item.labelKey)}
            </NavLink>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Sign-in, sign-up and the other pages that exist before there is a session. */
export function AuthLayout({
  title,
  subtitle,
  children,
  footer,
  wide,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  wide?: boolean;
}) {
  const { config } = useAuth();
  const { t } = useI18n();

  return (
    <div className="flex min-h-full flex-col items-center justify-center px-5 py-12">
      <div className={cx("w-full", wide ? "max-w-2xl" : "max-w-md")}>
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <Wordmark name={config?.serverName ?? "Ravelon Sync"} large />
          <Badge tone="neutral">
            <Shield className="mr-1.5 h-3 w-3" />
            {t("brand.tagline")}
          </Badge>
        </div>

        <div className="panel animate-rise overflow-hidden">
          <div className="border-b border-line-soft px-6 py-5">
            <h1 className="text-lg font-semibold tracking-[-0.01em] text-fg">{title}</h1>
            {subtitle ? <p className="mt-1.5 text-[13px] leading-relaxed text-fg2">{subtitle}</p> : null}
          </div>
          <div className="px-6 py-6">{children}</div>
        </div>

        {footer ? <div className="mt-5 text-center text-[13px] text-fg2">{footer}</div> : null}

        {config?.maintenanceMode ? (
          <Notice tone="warn" className="mt-5">
            {config.maintenanceMessage || t("status.maintenance")}
          </Notice>
        ) : null}
      </div>
    </div>
  );
}

export function AuthFooterLink({ children, onClick }: { children: React.ReactNode; onClick(): void }) {
  return (
    <Button variant="ghost" size="sm" onClick={onClick}>
      {children}
    </Button>
  );
}
