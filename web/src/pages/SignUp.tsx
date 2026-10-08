import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Ticket } from "lucide-react";

import { AuthLayout } from "../components/Shell";
import { Button, Field, Input, Notice } from "../components/ui";
import { useAuth } from "../lib/auth";
import { useAction } from "../lib/hooks";
import { useI18n } from "../lib/i18n";
import { safeNext, teamTokenFromNext } from "../lib/navigation";

export function SignUp() {
  const { t } = useI18n();
  const { config, signUp } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { run, pending, error } = useAction();

  const inviteToken = params.get("invite") ?? undefined;
  const next = safeNext(params.get("next"));
  // A team invitation admits its own address even where sign-up needs an
  // invitation; it arrives directly or inside the invitation page's "next".
  const teamInviteToken = inviteToken
    ? undefined
    : (params.get("team") ?? teamTokenFromNext(next) ?? undefined);
  const [email, setEmail] = useState(params.get("email") ?? "");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");

  const minLength = config?.passwordMinLength ?? 10;
  // An invitation is its own permission to register, so the deployment's mode
  // only decides whether the walk-in form should exist at all.
  const openToWalkIns = config?.registrationOpen || config?.registrationMode === "domain";
  const blocked = !inviteToken && !teamInviteToken && !openToWalkIns;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const result = await run(async () => {
      await signUp({
        email,
        password,
        displayName: displayName.trim() || undefined,
        inviteToken,
        teamInviteToken,
      });
      return true;
    });
    // Signing up with a team invitation already joined the team.
    if (result) navigate(next !== "/" ? next : teamInviteToken ? "/teams" : "/", { replace: true });
  };

  if (blocked) {
    return (
      <AuthLayout title={t("auth.signUpTitle")}>
        <Notice tone="warn">
          {config?.registrationMode === "closed" ? t("auth.registrationClosed") : t("auth.inviteRequired")}
        </Notice>
        <Link
          to="/signin"
          className="mt-5 block text-center text-[13px] font-medium text-teal underline-offset-2 hover:underline"
        >
          {t("auth.signIn")}
        </Link>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title={t("auth.signUpTitle")}
      subtitle={t("auth.signUpSubtitle")}
      footer={
        <>
          {t("auth.haveAccount")}{" "}
          <Link
            to={params.get("next") ? `/signin?next=${encodeURIComponent(next)}` : "/signin"}
            className="font-medium text-teal underline-offset-2 hover:underline"
          >
            {t("auth.signIn")}
          </Link>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-5">
        {inviteToken ? (
          <Notice tone="ok">
            <span className="flex items-center gap-2">
              <Ticket className="h-4 w-4 shrink-0 text-ok" />
              {t("auth.inviteAccepted")}
            </span>
          </Notice>
        ) : null}
        {teamInviteToken ? (
          <Notice tone="ok">
            <span className="flex items-center gap-2">
              <Ticket className="h-4 w-4 shrink-0 text-ok" />
              {t("auth.teamInviteAccepted")}
            </span>
          </Notice>
        ) : null}
        {!inviteToken && config?.registrationMode === "domain" && config.allowedEmailDomains.length > 0 ? (
          <Notice tone="info">
            {t("auth.domainRestricted", { domains: config.allowedEmailDomains.join(", ") })}
          </Notice>
        ) : null}
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
        <Field label={`${t("auth.displayName")} (${t("common.optional")})`} htmlFor="display-name">
          <Input
            id="display-name"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            autoComplete="name"
            maxLength={80}
          />
        </Field>
        <Field
          label={t("common.password")}
          hint={t("auth.passwordHint", { min: minLength })}
          htmlFor="password"
        >
          <Input
            id="password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="new-password"
            minLength={minLength}
            required
          />
        </Field>

        <Button type="submit" variant="primary" loading={pending} className="w-full">
          {t("auth.signUp")}
        </Button>
      </form>
    </AuthLayout>
  );
}
