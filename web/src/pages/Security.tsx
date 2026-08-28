import { useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Download, ShieldCheck } from "lucide-react";

import {
  Badge,
  Button,
  CopyField,
  Dialog,
  Field,
  Input,
  LoadingBlock,
  Notice,
  Panel,
  PanelHeader,
  PageHeader,
} from "../components/ui";
import { api } from "../lib/api";
import { useAccount, useAuth } from "../lib/auth";
import { formatDateTime } from "../lib/format";
import { useAction, useAsync, useDocumentTitle } from "../lib/hooks";
import { useI18n } from "../lib/i18n";
import type { MfaStatus } from "../lib/types";

export function Security() {
  const { t, locale } = useI18n();
  const { config, reloadAccount } = useAuth();
  const account = useAccount();
  useDocumentTitle(t("security.title"), config?.serverName);

  const status = useAsync((signal) => api.get<MfaStatus>("/v1/account/mfa", { signal }), []);
  const [enrolling, setEnrolling] = useState(false);
  const [disabling, setDisabling] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);

  const refresh = async () => {
    status.reload();
    await reloadAccount();
  };

  return (
    <>
      <PageHeader title={t("security.title")} />

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel>
          <PanelHeader
            title={t("security.mfaTitle")}
            action={
              status.data?.enabled ? (
                <Badge tone="ok">{t("admin.systemEnabled")}</Badge>
              ) : (
                <Badge tone="warn">{t("admin.systemDisabled")}</Badge>
              )
            }
          />
          {status.loading ? (
            <LoadingBlock />
          ) : (
            <div className="space-y-4 px-5 py-4">
              <p className="text-[13px] leading-relaxed text-fg2">
                {status.data?.enabled ? t("security.mfaOnBody") : t("security.mfaOffBody")}
              </p>
              {status.data?.enabled ? (
                <>
                  <p className="text-[12.5px] text-fg3">
                    {t("common.updated")} {formatDateTime(status.data.confirmedAt, locale)}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="danger" onClick={() => setDisabling(true)}>
                      {t("security.mfaDisable")}
                    </Button>
                  </div>
                </>
              ) : (
                <Button
                  variant="primary"
                  icon={<ShieldCheck className="h-4 w-4" />}
                  onClick={() => setEnrolling(true)}
                >
                  {t("security.mfaEnable")}
                </Button>
              )}
            </div>
          )}
        </Panel>

        {status.data?.enabled ? (
          <Panel>
            <PanelHeader title={t("security.recoveryTitle")} description={t("security.recoveryBody")} />
            <div className="space-y-4 px-5 py-4">
              <p className="text-[13px] text-fg2">
                {t("security.recoveryRemaining", { count: status.data.recoveryCodesRemaining })}
              </p>
              {status.data.recoveryCodesRemaining <= 2 ? (
                <Notice tone="warn">{t("security.recoveryBody")}</Notice>
              ) : null}
              <Button onClick={() => setRegenerating(true)}>{t("security.recoveryRegenerate")}</Button>
            </div>
          </Panel>
        ) : null}
      </div>

      <EnrollDialog
        open={enrolling}
        onClose={() => setEnrolling(false)}
        onEnrolled={async (recoveryCodes) => {
          setEnrolling(false);
          setCodes(recoveryCodes);
          await refresh();
        }}
      />

      <ReauthDialog
        open={disabling}
        onClose={() => setDisabling(false)}
        tone="danger"
        title={t("security.mfaDisable")}
        description={t("security.disableWarning")}
        requireMfa
        submitLabel={t("security.mfaDisable")}
        onSubmit={async (body) => {
          await api.delete("/v1/account/mfa", { body });
          await refresh();
        }}
      />

      <ReauthDialog
        open={regenerating}
        onClose={() => setRegenerating(false)}
        title={t("security.recoveryRegenerate")}
        description={t("security.recoveryBody")}
        requireMfa={false}
        submitLabel={t("security.recoveryRegenerate")}
        onSubmit={async (body) => {
          const result = await api.post<{ recoveryCodes: string[] }>(
            "/v1/account/mfa/recovery-codes",
            body,
          );
          setRegenerating(false);
          setCodes(result.recoveryCodes);
          await refresh();
        }}
      />

      <RecoveryCodesDialog
        codes={codes}
        onClose={() => setCodes(null)}
        serverName={config?.serverName ?? "Ravelon Sync"}
        email={account.user.email}
      />
    </>
  );
}

/**
 * Enrolment, in two steps.
 *
 * The password comes first because the secret is only shown to somebody who
 * just proved they are the account holder; the code then proves the
 * authenticator really holds it, which is what turns it into a second factor.
 */
function EnrollDialog({
  open,
  onClose,
  onEnrolled,
}: {
  open: boolean;
  onClose(): void;
  onEnrolled(codes: string[]): Promise<void>;
}) {
  const { t } = useI18n();
  const account = useAccount();
  const { run, pending, error } = useAction();
  const [password, setPassword] = useState("");
  const [secret, setSecret] = useState<{ secret: string; uri: string } | null>(null);
  const [code, setCode] = useState("");

  const start = async (event: React.FormEvent) => {
    event.preventDefault();
    const result = await run(() =>
      api.post<{ secret: string; uri: string }>("/v1/account/mfa/totp/setup", { password }),
    );
    if (result) setSecret(result);
  };

  const confirm = async (event: React.FormEvent) => {
    event.preventDefault();
    const result = await run(() =>
      api.post<{ recoveryCodes: string[] }>("/v1/account/mfa/totp/confirm", { code: code.trim() }),
    );
    if (!result) return;
    setPassword("");
    setSecret(null);
    setCode("");
    await onEnrolled(result.recoveryCodes);
  };

  const close = () => {
    setPassword("");
    setSecret(null);
    setCode("");
    onClose();
  };

  return (
    <Dialog open={open} onClose={close} title={t("security.mfaEnable")}>
      {!secret ? (
        <form onSubmit={start} className="space-y-4">
          {error ? <Notice tone="danger">{error}</Notice> : null}
          <Field label={t("account.currentPassword")} htmlFor="mfa-password">
            <Input
              id="mfa-password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              required
            />
          </Field>
          <div className="flex justify-end gap-2 pt-2">
            <Button onClick={close}>{t("common.cancel")}</Button>
            <Button type="submit" variant="primary" loading={pending}>
              {t("common.continue")}
            </Button>
          </div>
        </form>
      ) : (
        <form onSubmit={confirm} className="space-y-5">
          {error ? <Notice tone="danger">{error}</Notice> : null}
          <div>
            <p className="label-caps mb-3">{t("security.mfaScan")}</p>
            <div className="flex justify-center rounded-lg border border-line bg-white p-4">
              <QRCodeSVG value={secret.uri} size={168} level="M" />
            </div>
          </div>
          <CopyField value={secret.secret} label={t("security.mfaManualEntry")} />
          <Field label={t("auth.mfaCode")} hint={t("security.mfaConfirmHint")} htmlFor="mfa-confirm">
            <Input
              id="mfa-confirm"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              autoComplete="one-time-code"
              inputMode="numeric"
              className="text-center font-mono text-lg tracking-[0.3em]"
              placeholder="000000"
              required
            />
          </Field>
          <p className="text-[12px] text-fg3">{account.user.email}</p>
          <div className="flex justify-end gap-2">
            <Button onClick={close}>{t("common.cancel")}</Button>
            <Button type="submit" variant="primary" loading={pending}>
              {t("common.confirm")}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

/** Password, and a code when the account has one, before a sensitive change. */
function ReauthDialog({
  open,
  onClose,
  title,
  description,
  tone,
  requireMfa,
  submitLabel,
  onSubmit,
}: {
  open: boolean;
  onClose(): void;
  title: string;
  description?: string;
  tone?: "neutral" | "danger";
  requireMfa: boolean;
  submitLabel: string;
  onSubmit(body: { password: string; mfaCode?: string }): Promise<void>;
}) {
  const { t } = useI18n();
  const account = useAccount();
  const { run, pending, error } = useAction();
  const [password, setPassword] = useState("");
  const [mfaCode, setMfaCode] = useState("");

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const result = await run(async () => {
      await onSubmit({
        password,
        ...(mfaCode.trim() ? { mfaCode: mfaCode.trim() } : {}),
      });
      return true;
    });
    if (!result) return;
    setPassword("");
    setMfaCode("");
    onClose();
  };

  return (
    <Dialog open={open} onClose={onClose} tone={tone} title={title} description={description}>
      <form onSubmit={submit} className="space-y-4">
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <Field label={t("account.currentPassword")} htmlFor="reauth-password">
          <Input
            id="reauth-password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            required
          />
        </Field>
        {account.mfaEnabled && requireMfa ? (
          <Field label={t("auth.mfaCode")} hint={t("auth.mfaRecoveryHint")} htmlFor="reauth-mfa">
            <Input
              id="reauth-mfa"
              value={mfaCode}
              onChange={(event) => setMfaCode(event.target.value)}
              autoComplete="one-time-code"
              className="font-mono tracking-[0.2em]"
              placeholder="000000"
              required
            />
          </Field>
        ) : null}
        <div className="flex justify-end gap-2 pt-2">
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button type="submit" variant={tone === "danger" ? "danger" : "primary"} loading={pending}>
            {submitLabel}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function RecoveryCodesDialog({
  codes,
  onClose,
  serverName,
  email,
}: {
  codes: string[] | null;
  onClose(): void;
  serverName: string;
  email: string;
}) {
  const { t } = useI18n();
  const [acknowledged, setAcknowledged] = useState(false);

  const download = () => {
    if (!codes) return;
    const content = [
      `${serverName} recovery codes`,
      `Account: ${email}`,
      `Generated: ${new Date().toISOString()}`,
      "",
      "Each code works once. Store them somewhere you can reach without this account.",
      "",
      ...codes,
      "",
    ].join("\n");
    const url = URL.createObjectURL(new Blob([content], { type: "text/plain" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "ravelon-sync-recovery-codes.txt";
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Dialog
      open={Boolean(codes)}
      onClose={() => {
        setAcknowledged(false);
        onClose();
      }}
      title={t("security.recoveryTitle")}
      description={t("security.recoveryBody")}
      footer={
        <>
          <Button icon={<Download className="h-4 w-4" />} onClick={download}>
            {t("security.recoveryDownload")}
          </Button>
          <Button
            variant="primary"
            // Closing is gated on an explicit acknowledgement: these codes are
            // shown exactly once, and a stray click would lose them.
            disabled={!acknowledged}
            onClick={() => {
              setAcknowledged(false);
              onClose();
            }}
          >
            {t("common.close")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <ul className="grid grid-cols-2 gap-2 rounded-lg border border-line bg-ink p-4">
          {(codes ?? []).map((code) => (
            <li key={code} className="font-mono text-[13px] tracking-wide text-fg2">
              {code}
            </li>
          ))}
        </ul>
        <label className="flex cursor-pointer items-start gap-2.5 text-[13px] text-fg2">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(event) => setAcknowledged(event.target.checked)}
            className="mt-0.5 h-4 w-4 accent-[rgb(22_214_199)]"
          />
          {t("security.recoveryAcknowledge")}
        </label>
      </div>
    </Dialog>
  );
}
