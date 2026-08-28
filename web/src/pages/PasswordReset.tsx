import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";

import { AuthLayout } from "../components/Shell";
import { Button, Field, Input, Notice, Spinner } from "../components/ui";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useAction } from "../lib/hooks";
import { useI18n } from "../lib/i18n";

/** Asks for a link. The answer never says whether the address exists. */
export function ForgotPassword() {
  const { t } = useI18n();
  const { config } = useAuth();
  const { run, pending, error, done } = useAction();
  const [email, setEmail] = useState("");

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    await run(() => api.post("/v1/auth/password/reset/request", { email }, { anonymous: true }));
  };

  return (
    <AuthLayout
      title={t("auth.resetTitle")}
      subtitle={t("auth.resetSubtitle")}
      footer={
        <Link to="/signin" className="font-medium text-teal underline-offset-2 hover:underline">
          {t("auth.signIn")}
        </Link>
      }
    >
      {done ? (
        <Notice tone="ok">{t("auth.resetSent")}</Notice>
      ) : (
        <form onSubmit={submit} className="space-y-5">
          {error ? <Notice tone="danger">{error}</Notice> : null}
          <Field label={t("common.email")} htmlFor="email">
            <Input
              id="email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="username"
              autoFocus
              required
            />
          </Field>
          <Button type="submit" variant="primary" loading={pending} className="w-full">
            {t("common.continue")}
          </Button>
          {/* Without mail there is no link to send, so the honest answer is to
              point at the administrator rather than let someone wait for one. */}
          {config && !config.maintenanceMode ? (
            <p className="text-center text-[12.5px] leading-relaxed text-fg3">{t("auth.resetNoSmtp")}</p>
          ) : null}
        </form>
      )}
    </AuthLayout>
  );
}

export function ResetPassword() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { run, pending, error, done } = useAction();
  const [password, setPassword] = useState("");

  const token = params.get("token") ?? "";

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    await run(() =>
      api.post("/v1/auth/password/reset/confirm", { token, newPassword: password }, { anonymous: true }),
    );
  };

  if (!token) {
    return (
      <AuthLayout title={t("auth.resetTitle")}>
        <Notice tone="danger">{t("error.notFound")}</Notice>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title={t("auth.resetTitle")}>
      {done ? (
        <div className="space-y-5">
          <Notice tone="ok">{t("auth.resetDone")}</Notice>
          <Button variant="primary" className="w-full" onClick={() => navigate("/signin")}>
            {t("auth.signIn")}
          </Button>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-5">
          {error ? <Notice tone="danger">{error}</Notice> : null}
          <Field
            label={t("auth.resetNewPassword")}
            hint={t("auth.passwordHint", { min: 10 })}
            htmlFor="new-password"
          >
            <Input
              id="new-password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="new-password"
              minLength={10}
              autoFocus
              required
            />
          </Field>
          <Button type="submit" variant="primary" loading={pending} className="w-full">
            {t("common.confirm")}
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}

export function VerifyEmail() {
  const { t } = useI18n();
  const { reloadAccount } = useAuth();
  const [params] = useSearchParams();
  const [state, setState] = useState<"pending" | "done" | "failed">("pending");

  const token = params.get("token") ?? "";

  useEffect(() => {
    if (!token) {
      setState("failed");
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        await api.post("/v1/auth/verify-email/confirm", { token }, { anonymous: true });
        if (cancelled) return;
        setState("done");
        // The banner in the shell reads the account, so it has to be refetched
        // for the confirmation to actually disappear.
        await reloadAccount().catch(() => null);
      } catch {
        if (!cancelled) setState("failed");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, reloadAccount]);

  return (
    <AuthLayout
      title={t("auth.verifyEmailTitle")}
      footer={
        <Link to="/" className="font-medium text-teal underline-offset-2 hover:underline">
          {t("nav.overview")}
        </Link>
      }
    >
      {state === "pending" ? (
        <div className="flex items-center gap-3 text-[13px] text-fg2">
          <Spinner />
          {t("auth.verifyEmailPending")}
        </div>
      ) : state === "done" ? (
        <Notice tone="ok">{t("auth.verifyEmailDone")}</Notice>
      ) : (
        <Notice tone="danger">{t("auth.verifyEmailFailed")}</Notice>
      )}
    </AuthLayout>
  );
}
