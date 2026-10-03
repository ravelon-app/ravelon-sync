import { BrowserRouter, Navigate, Route, Routes, useLocation, useSearchParams } from "react-router-dom";
import type { ReactNode } from "react";

import { Shell } from "./components/Shell";
import { Notice, Spinner } from "./components/ui";
import { AuthProvider, useAuth } from "./lib/auth";
import { safeNext } from "./lib/navigation";
import { I18nProvider, useI18n } from "./lib/i18n";
import { Account } from "./pages/Account";
import { Devices } from "./pages/Devices";
import { LinkDevice } from "./pages/LinkDevice";
import { Overview } from "./pages/Overview";
import { ForgotPassword, ResetPassword, VerifyEmail } from "./pages/PasswordReset";
import { Security } from "./pages/Security";
import { Setup } from "./pages/Setup";
import { SignIn } from "./pages/SignIn";
import { SignUp } from "./pages/SignUp";
import { AcceptTeamInvite, Teams } from "./pages/Teams";
import { Vaults } from "./pages/Vaults";
import { AdminAudit, AdminVaults } from "./pages/admin/Insights";
import { AdminInvites } from "./pages/admin/Invites";
import { AdminSettings } from "./pages/admin/Settings";
import { AdminSystem } from "./pages/admin/System";
import { AdminUsers } from "./pages/admin/Users";

export function App() {
  return (
    <I18nProvider>
      <AuthProvider>
        <BrowserRouter>
          <Router />
        </BrowserRouter>
      </AuthProvider>
    </I18nProvider>
  );
}

function Router() {
  const { ready, config, signedIn, account } = useAuth();

  // Nothing renders against a guess: a flash of the sign-in page for somebody
  // who is already signed in is worse than a moment of nothing.
  if (!ready) {
    return (
      <div className="flex min-h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }

  // A deployment with no accounts has exactly one thing to offer, so every
  // route leads there until the first administrator exists.
  if (config?.needsSetup && !signedIn) {
    return (
      <Routes>
        <Route path="/setup" element={<Setup />} />
        <Route path="*" element={<Navigate to="/setup" replace />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route path="/signin" element={<RedirectIfSignedIn><SignIn /></RedirectIfSignedIn>} />
      <Route path="/signup" element={<RedirectIfSignedIn><SignUp /></RedirectIfSignedIn>} />
      <Route path="/forgot-password" element={<RedirectIfSignedIn><ForgotPassword /></RedirectIfSignedIn>} />
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route path="/verify-email" element={<VerifyEmail />} />
      {/* Reachable signed out on purpose: both send the visitor to sign in and
          then bring them straight back with the token intact. */}
      <Route path="/link-device" element={<LinkDevice />} />
      <Route path="/invite/team" element={<AcceptTeamInvite />} />
      <Route path="/setup" element={<Navigate to="/" replace />} />

      <Route element={<RequireAuth><Shell /></RequireAuth>}>
        <Route path="/" element={<Overview />} />
        <Route path="/vaults" element={<Vaults />} />
        <Route path="/teams" element={<Teams />} />
        <Route path="/devices" element={<Devices />} />
        <Route path="/account" element={<Account />} />
        <Route path="/security" element={<Security />} />
        <Route path="/admin" element={<RequireAdmin><AdminUsers /></RequireAdmin>} />
        <Route path="/admin/invites" element={<RequireAdmin><AdminInvites /></RequireAdmin>} />
        <Route path="/admin/vaults" element={<RequireAdmin><AdminVaults /></RequireAdmin>} />
        <Route path="/admin/audit" element={<RequireAdmin><AdminAudit /></RequireAdmin>} />
        <Route path="/admin/settings" element={<RequireAdmin><AdminSettings /></RequireAdmin>} />
        <Route path="/admin/system" element={<RequireAdmin><AdminSystem /></RequireAdmin>} />
        <Route path="*" element={<NotFound />} />
      </Route>

      <Route path="*" element={<Navigate to={account ? "/" : "/signin"} replace />} />
    </Routes>
  );
}

function RequireAuth({ children }: { children: ReactNode }) {
  const { signedIn } = useAuth();
  const location = useLocation();
  if (!signedIn) {
    // The destination is carried along, so signing in lands where the person
    // was actually going rather than dumping them on the overview.
    const next = `${location.pathname}${location.search}`;
    return <Navigate to={`/signin?next=${encodeURIComponent(next)}`} replace />;
  }
  return <>{children}</>;
}

function RequireAdmin({ children }: { children: ReactNode }) {
  const { account } = useAuth();
  const { t } = useI18n();
  if (account?.user.role !== "admin") {
    return <Notice tone="danger">{t("error.forbidden")}</Notice>;
  }
  return <>{children}</>;
}

function RedirectIfSignedIn({ children }: { children: ReactNode }) {
  const { signedIn } = useAuth();
  const [params] = useSearchParams();
  // The page that sent someone here wins. Without this, finishing a sign-in
  // re-rendered this guard first and dropped the "next" the form was about to
  // follow, so a second factor or a team invitation landed on the overview.
  if (signedIn) return <Navigate to={safeNext(params.get("next"))} replace />;
  return <>{children}</>;
}

function NotFound() {
  const { t } = useI18n();
  return <Notice tone="warn">{t("error.notFound")}</Notice>;
}
