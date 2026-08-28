import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Monitor, Smartphone } from "lucide-react";

import { AuthLayout } from "../components/Shell";
import { Button, Field, Input, LoadingBlock, Notice } from "../components/ui";
import { api } from "../lib/api";
import { useAccount, useAuth } from "../lib/auth";
import { useAction, useAsync } from "../lib/hooks";
import { useI18n } from "../lib/i18n";
import type { PairingRequest } from "../lib/types";

/**
 * Approves a Ravelon app that asked to sign in.
 *
 * The app never sees the password: it polls for a session that this page,
 * signed in already, decides to hand it. The code shown here is what makes
 * approving somebody else's pending request visible rather than silent.
 */
export function LinkDevice() {
  const { t } = useI18n();
  const { signedIn } = useAuth();
  const [params] = useSearchParams();
  const requestId = params.get("request") ?? "";

  const request = useAsync(
    (signal) =>
      requestId
        ? api.get<PairingRequest>(`/v1/desktop-auth/request/${encodeURIComponent(requestId)}`, {
            anonymous: true,
            signal,
          })
        : Promise.reject(new Error("missing")),
    [requestId],
  );

  if (!requestId || request.error) {
    return (
      <AuthLayout title={t("pairing.title")}>
        <Notice tone="danger">{t("pairing.notFound")}</Notice>
      </AuthLayout>
    );
  }
  if (request.loading || !request.data) {
    return (
      <AuthLayout title={t("pairing.title")}>
        <LoadingBlock />
      </AuthLayout>
    );
  }
  if (request.data.status === "expired") {
    return (
      <AuthLayout title={t("pairing.title")}>
        <Notice tone="warn">{t("pairing.expired")}</Notice>
      </AuthLayout>
    );
  }
  if (request.data.status !== "pending") {
    return (
      <AuthLayout title={t("pairing.title")}>
        <Notice tone="ok">{t("pairing.approved")}</Notice>
      </AuthLayout>
    );
  }

  if (!signedIn) {
    return (
      <AuthLayout title={t("pairing.title")} subtitle={t("pairing.signInFirst")}>
        <PairingSummary request={request.data} />
        <Link
          to={`/signin?next=${encodeURIComponent(`/link-device?request=${requestId}`)}`}
          className="mt-6 block"
        >
          <Button variant="primary" className="w-full">
            {t("auth.signIn")}
          </Button>
        </Link>
      </AuthLayout>
    );
  }

  return <ApprovePairing request={request.data} />;
}

function ApprovePairing({ request }: { request: PairingRequest }) {
  const { t } = useI18n();
  const account = useAccount();
  const { run, pending, error, done } = useAction();
  const [password, setPassword] = useState("");
  const [mfaCode, setMfaCode] = useState("");

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    await run(() =>
      api.post("/v1/desktop-auth/approve", {
        requestId: request.requestId,
        password,
        ...(mfaCode.trim() ? { mfaCode: mfaCode.trim() } : {}),
      }),
    );
  };

  if (done) {
    return (
      <AuthLayout title={t("pairing.title")}>
        <Notice tone="ok">{t("pairing.approved")}</Notice>
        <Link to="/" className="mt-6 block">
          <Button className="w-full">{t("nav.overview")}</Button>
        </Link>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title={t("pairing.title")} subtitle={t("pairing.subtitle")}>
      <PairingSummary request={request} />
      <form onSubmit={submit} className="mt-6 space-y-5">
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <Field label={t("pairing.confirmPassword")} htmlFor="password">
          <Input
            id="password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            autoFocus
            required
          />
        </Field>
        {account.mfaEnabled ? (
          <Field label={t("auth.mfaCode")} htmlFor="mfa-code">
            <Input
              id="mfa-code"
              value={mfaCode}
              onChange={(event) => setMfaCode(event.target.value)}
              autoComplete="one-time-code"
              className="font-mono tracking-[0.2em]"
              placeholder="000000"
              required
            />
          </Field>
        ) : null}
        <Button type="submit" variant="primary" loading={pending} className="w-full">
          {t("pairing.approve")}
        </Button>
      </form>
    </AuthLayout>
  );
}

function PairingSummary({ request }: { request: PairingRequest }) {
  const { t } = useI18n();
  const Icon = request.platform === "ios" || request.platform === "android" ? Smartphone : Monitor;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 rounded-lg border border-line bg-raised px-4 py-3">
        <Icon className="h-5 w-5 shrink-0 text-fg3" />
        <div className="min-w-0">
          <p className="label-caps">{t("pairing.device")}</p>
          <p className="truncate text-sm font-medium text-fg">{request.deviceName}</p>
        </div>
      </div>
      <div className="text-center">
        <p className="label-caps">{t("pairing.codeLabel")}</p>
        <p className="mt-2 font-mono text-3xl font-semibold tracking-[0.15em] text-teal tabular-nums">
          {request.userCode}
        </p>
      </div>
    </div>
  );
}
