import { useState } from "react";
import { Download } from "lucide-react";

import {
  Badge,
  Button,
  Dialog,
  Field,
  Input,
  Notice,
  Panel,
  PanelHeader,
  PageHeader,
} from "../components/ui";
import { api, getSession } from "../lib/api";
import { useAccount, useAuth } from "../lib/auth";
import { formatDateTime } from "../lib/format";
import { useAction, useDocumentTitle } from "../lib/hooks";
import { useI18n } from "../lib/i18n";

export function Account() {
  const { t, locale } = useI18n();
  const { config, reloadAccount, signOut } = useAuth();
  const account = useAccount();
  useDocumentTitle(t("account.title"), config?.serverName);

  return (
    <>
      <PageHeader title={t("account.title")} />

      <div className="grid gap-6 lg:grid-cols-2">
        <ProfilePanel onSaved={reloadAccount} />
        <VerificationPanel />
        <PasswordPanel />
        <ExportPanel />
      </div>

      <div className="mt-6">
        <DeleteAccountPanel onDeleted={signOut} />
      </div>

      <p className="mt-6 text-center text-[12px] text-fg3">
        {t("common.created")} {formatDateTime(account.user.createdAt, locale)}
      </p>
    </>
  );
}

function ProfilePanel({ onSaved }: { onSaved(): Promise<void> }) {
  const { t } = useI18n();
  const account = useAccount();
  const { run, pending, error, done } = useAction();
  const [displayName, setDisplayName] = useState(account.user.displayName ?? "");

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const saved = await run(() => api.patch("/v1/account", { displayName: displayName.trim() || null }));
    if (saved !== undefined) await onSaved();
  };

  return (
    <Panel>
      <PanelHeader title={t("account.profile")} />
      <form onSubmit={submit} className="space-y-4 px-5 py-4">
        {error ? <Notice tone="danger">{error}</Notice> : null}
        {done ? <Notice tone="ok">{t("common.saved")}</Notice> : null}
        <Field label={t("common.email")} htmlFor="account-email">
          {/* The address is the account identity and the invitation target, so
              changing it is deliberately not a self-service action here. */}
          <Input id="account-email" value={account.user.email} readOnly disabled />
        </Field>
        <Field label={t("auth.displayName")} htmlFor="account-name">
          <Input
            id="account-name"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            maxLength={80}
          />
        </Field>
        <div className="flex justify-end">
          <Button type="submit" variant="primary" loading={pending}>
            {t("common.save")}
          </Button>
        </div>
      </form>
    </Panel>
  );
}

function VerificationPanel() {
  const { t } = useI18n();
  const account = useAccount();
  const { run, pending, error, done } = useAction();
  const [noMail, setNoMail] = useState(false);

  const resend = async () => {
    const result = await run(() =>
      api.post<{ requested: boolean; delivered?: boolean }>("/v1/auth/verify-email/request"),
    );
    if (result && result.delivered === false) setNoMail(true);
  };

  return (
    <Panel>
      <PanelHeader
        title={t("common.email")}
        action={
          account.user.emailVerified ? (
            <Badge tone="ok">{t("account.emailVerified")}</Badge>
          ) : (
            <Badge tone="warn">{t("account.emailUnverified")}</Badge>
          )
        }
      />
      <div className="space-y-4 px-5 py-4">
        <p className="text-[13px] text-fg2">{account.user.email}</p>
        {error ? <Notice tone="danger">{error}</Notice> : null}
        {noMail ? (
          <Notice tone="warn">{t("account.verificationNoMail")}</Notice>
        ) : done ? (
          <Notice tone="ok">{t("account.verificationSent")}</Notice>
        ) : null}
        {!account.user.emailVerified ? (
          <Button loading={pending} onClick={() => void resend()}>
            {t("account.resendVerification")}
          </Button>
        ) : null}
      </div>
    </Panel>
  );
}

function PasswordPanel() {
  const { t } = useI18n();
  const account = useAccount();
  const { run, pending, error, done } = useAction();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [mfaCode, setMfaCode] = useState("");

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    // The endpoint answers 204, so success is signalled explicitly rather
    // than read from the empty response body.
    const changed = await run(async () => {
      await api.post("/v1/auth/password/change", {
        currentPassword,
        newPassword,
        ...(account.mfaEnabled && mfaCode.trim() ? { mfaCode: mfaCode.trim() } : {}),
      });
      return true;
    });
    if (changed === undefined) return;
    setCurrentPassword("");
    setNewPassword("");
    setMfaCode("");
  };

  return (
    <Panel>
      <PanelHeader title={t("account.changePassword")} />
      <form onSubmit={submit} className="space-y-4 px-5 py-4">
        {error ? <Notice tone="danger">{error}</Notice> : null}
        {done ? <Notice tone="ok">{t("account.passwordChanged")}</Notice> : null}
        {/* The server cannot re-seal the account key; only a device can. */}
        <Notice tone="info">{t("account.passwordKeyNote")}</Notice>
        <Field label={t("account.currentPassword")} htmlFor="current-password">
          <Input
            id="current-password"
            type="password"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
            autoComplete="current-password"
            required
          />
        </Field>
        <Field
          label={t("account.newPassword")}
          hint={t("auth.passwordHint", { min: 10 })}
          htmlFor="new-password"
        >
          <Input
            id="new-password"
            type="password"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
            autoComplete="new-password"
            minLength={10}
            required
          />
        </Field>
        {account.mfaEnabled ? (
          <Field label={t("auth.mfaCode")} hint={t("auth.mfaRecoveryHint")} htmlFor="password-mfa">
            <Input
              id="password-mfa"
              value={mfaCode}
              onChange={(event) => setMfaCode(event.target.value)}
              autoComplete="one-time-code"
              className="font-mono tracking-[0.2em]"
              placeholder="000000"
              required
            />
          </Field>
        ) : null}
        <div className="flex justify-end">
          <Button type="submit" variant="primary" loading={pending}>
            {t("account.changePassword")}
          </Button>
        </div>
      </form>
    </Panel>
  );
}

function ExportPanel() {
  const { t } = useI18n();
  const { run, pending, error } = useAction();

  const download = async () => {
    await run(async () => {
      // Fetched through the client so the bearer token is attached, then
      // handed to the browser as a file rather than opened in a tab.
      const response = await fetch("/v1/account/export", {
        headers: { authorization: `Bearer ${getSession()?.accessToken ?? ""}` },
      });
      if (!response.ok) throw new Error(`${response.status}`);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `ravelon-sync-export-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(url);
      return true;
    });
  };

  return (
    <Panel>
      <PanelHeader title={t("account.exportTitle")} description={t("account.exportBody")} />
      <div className="space-y-3 px-5 py-4">
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <Button loading={pending} icon={<Download className="h-4 w-4" />} onClick={() => void download()}>
          {t("account.export")}
        </Button>
      </div>
    </Panel>
  );
}

function DeleteAccountPanel({ onDeleted }: { onDeleted(): Promise<void> }) {
  const { t } = useI18n();
  const account = useAccount();
  const { run, pending, error } = useAction();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [mfaCode, setMfaCode] = useState("");
  const [confirmation, setConfirmation] = useState("");

  const submit = async () => {
    const deleted = await run(() =>
      api.delete("/v1/account", {
        body: { password, ...(mfaCode.trim() ? { mfaCode: mfaCode.trim() } : {}) },
      }),
    );
    if (deleted === undefined) return;
    await onDeleted();
  };

  return (
    <>
      <Panel className="border-danger/30">
        <PanelHeader title={t("account.dangerZone")} description={t("account.deleteBody")} />
        <div className="px-5 py-4">
          <Button variant="danger" onClick={() => setOpen(true)}>
            {t("account.delete")}
          </Button>
        </div>
      </Panel>

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        tone="danger"
        title={t("account.delete")}
        description={t("account.deleteBody")}
        footer={
          <>
            <Button onClick={() => setOpen(false)}>{t("common.cancel")}</Button>
            <Button
              variant="danger"
              loading={pending}
              disabled={confirmation.trim().toLowerCase() !== account.user.email.toLowerCase()}
              onClick={() => void submit()}
            >
              {t("account.delete")}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {error ? <Notice tone="danger">{error}</Notice> : null}
          <Field label={t("common.password")} htmlFor="delete-password">
            <Input
              id="delete-password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
            />
          </Field>
          {account.mfaEnabled ? (
            <Field label={t("auth.mfaCode")} htmlFor="delete-mfa">
              <Input
                id="delete-mfa"
                value={mfaCode}
                onChange={(event) => setMfaCode(event.target.value)}
                className="font-mono tracking-[0.2em]"
                placeholder="000000"
              />
            </Field>
          ) : null}
          <Field label={t("account.deleteConfirm")} htmlFor="delete-confirm">
            <Input
              id="delete-confirm"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              placeholder={account.user.email}
              autoComplete="off"
            />
          </Field>
        </div>
      </Dialog>
    </>
  );
}
