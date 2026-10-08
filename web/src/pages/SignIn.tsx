import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";

import { AuthLayout } from "../components/Shell";
import { Button, Field, Input, Notice } from "../components/ui";
import { useAuth, type MfaChallenge } from "../lib/auth";
import { useAction } from "../lib/hooks";
import { useI18n } from "../lib/i18n";
import { safeNext } from "../lib/navigation";

export function SignIn() {
  const { t } = useI18n();
  const { config, signIn, verifyMfa } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { run, pending, error, setError } = useAction();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [challenge, setChallenge] = useState<MfaChallenge | null>(null);
  const [code, setCode] = useState("");

  const next = safeNext(params.get("next"));

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const result = await run(() => signIn(email, password));
    if (!result) return;
    if (result.state === "mfaRequired") {
      setChallenge(result.challenge);
      return;
    }
    navigate(next, { replace: true });
  };

  const submitCode = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!challenge) return;
    const result = await run(async () => {
      await verifyMfa(challenge.challengeToken, code);
      return true;
    });
    if (result) navigate(next, { replace: true });
  };

  if (challenge) {
    return (
      <AuthLayout title={t("auth.mfaTitle")} subtitle={t("auth.mfaSubtitle")}>
        <form onSubmit={submitCode} className="space-y-5">
          {error ? <Notice tone="danger">{error}</Notice> : null}
          <Field label={t("auth.mfaCode")} hint={t("auth.mfaRecoveryHint")} htmlFor="mfa-code">
            <Input
              id="mfa-code"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              // Digits and recovery codes both land here, so the pattern stays
              // open and the server decides which one it is.
              inputMode="text"
              autoComplete="one-time-code"
              autoFocus
              required
              className="text-center font-mono text-lg tracking-[0.3em]"
              placeholder="000000"
            />
          </Field>
          <Button type="submit" variant="primary" loading={pending} className="w-full">
            {t("auth.mfaVerify")}
          </Button>
          <button
            type="button"
            onClick={() => {
              setChallenge(null);
              setCode("");
              setError(null);
            }}
            className="flex w-full items-center justify-center gap-1.5 text-[13px] text-fg3 transition-colors hover:text-fg2"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            {t("common.back")}
          </button>
        </form>
      </AuthLayout>
    );
  }

  const canSignUp = config?.registrationOpen || config?.registrationMode === "domain";

  return (
    <AuthLayout
      title={t("auth.signInTitle", { server: config?.serverName ?? "Ravelon Sync" })}
      subtitle={t("auth.signInSubtitle")}
      footer={
        canSignUp ? (
          <>
            {t("auth.noAccount")}{" "}
            <Link
              to={params.get("next") ? `/signup?next=${encodeURIComponent(next)}` : "/signup"}
              className="font-medium text-teal underline-offset-2 hover:underline"
            >
              {t("auth.signUp")}
            </Link>
          </>
        ) : null
      }
    >
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
        <Field label={t("common.password")} htmlFor="password">
          <Input
            id="password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            required
          />
        </Field>
        <Button type="submit" variant="primary" loading={pending} className="w-full">
          {t("auth.signIn")}
        </Button>
        <div className="text-center">
          <Link
            to="/forgot-password"
            className="text-[13px] text-fg3 underline-offset-2 transition-colors hover:text-fg2 hover:underline"
          >
            {t("auth.forgotPassword")}
          </Link>
        </div>
      </form>
    </AuthLayout>
  );
}
