import { useEffect, useState } from "react";
import { Mail, Send } from "lucide-react";

import {
  Button,
  Field,
  Input,
  LoadingBlock,
  Notice,
  Panel,
  PanelHeader,
  PageHeader,
  Select,
  Textarea,
  Toggle,
} from "../../components/ui";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { useAction, useAsync, useDocumentTitle } from "../../lib/hooks";
import { useI18n } from "../../lib/i18n";
import type { AdminSettings, PlatformSettings, RegistrationMode } from "../../lib/types";

const REGISTRATION_MODES: Array<{
  value: RegistrationMode;
  label: "admin.settingsRegistrationOpen" | "admin.settingsRegistrationInvite" | "admin.settingsRegistrationDomain" | "admin.settingsRegistrationClosed";
  hint: "admin.settingsRegistrationOpenHint" | "admin.settingsRegistrationInviteHint" | "admin.settingsRegistrationDomainHint" | "admin.settingsRegistrationClosedHint";
}> = [
  { value: "invite", label: "admin.settingsRegistrationInvite", hint: "admin.settingsRegistrationInviteHint" },
  { value: "domain", label: "admin.settingsRegistrationDomain", hint: "admin.settingsRegistrationDomainHint" },
  { value: "open", label: "admin.settingsRegistrationOpen", hint: "admin.settingsRegistrationOpenHint" },
  { value: "closed", label: "admin.settingsRegistrationClosed", hint: "admin.settingsRegistrationClosedHint" },
];

export function AdminSettings() {
  const { t } = useI18n();
  const { config, reloadConfig } = useAuth();
  useDocumentTitle(t("admin.settingsTitle"), config?.serverName);

  const settings = useAsync((signal) => api.get<AdminSettings>("/v1/admin/settings", { signal }), []);

  return (
    <>
      <PageHeader title={t("admin.settingsTitle")} />
      {settings.error ? <Notice tone="danger">{settings.error}</Notice> : null}
      {settings.loading || !settings.data ? (
        <Panel>
          <LoadingBlock />
        </Panel>
      ) : (
        <div className="space-y-6">
          <PlatformPanel
            initial={settings.data.platform}
            onSaved={async () => {
              settings.reload();
              await reloadConfig();
            }}
          />
          <SmtpPanel settings={settings.data} onSaved={settings.reload} />
        </div>
      )}
    </>
  );
}

function PlatformPanel({
  initial,
  onSaved,
}: {
  initial: PlatformSettings;
  onSaved(): Promise<void>;
}) {
  const { t } = useI18n();
  const { run, pending, error, done } = useAction();
  const [form, setForm] = useState(initial);
  const [domains, setDomains] = useState(initial.allowedEmailDomains.join("\n"));

  useEffect(() => {
    setForm(initial);
    setDomains(initial.allowedEmailDomains.join("\n"));
  }, [initial]);

  const update = <K extends keyof PlatformSettings>(key: K, value: PlatformSettings[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const saved = await run(() =>
      api.put("/v1/admin/settings/platform", {
        ...form,
        allowedEmailDomains: domains
          .split(/[\n,]/)
          .map((entry) => entry.trim().toLowerCase())
          .filter(Boolean),
      }),
    );
    if (saved !== undefined) await onSaved();
  };

  return (
    <Panel>
      <PanelHeader title={t("admin.settingsGeneral")} />
      <form onSubmit={submit} className="space-y-6 px-5 py-5">
        {error ? <Notice tone="danger">{error}</Notice> : null}
        {done ? <Notice tone="ok">{t("common.saved")}</Notice> : null}

        <Field label={t("setup.serverName")} hint={t("setup.serverNameHint")} htmlFor="server-name">
          <Input
            id="server-name"
            value={form.serverName}
            onChange={(event) => update("serverName", event.target.value)}
            maxLength={80}
            required
          />
        </Field>

        <fieldset className="space-y-2.5">
          <legend className="mb-2 text-[13px] font-medium text-fg">
            {t("admin.settingsRegistration")}
          </legend>
          {REGISTRATION_MODES.map((mode) => (
            <label
              key={mode.value}
              className={[
                "flex cursor-pointer items-start gap-3 rounded-lg border px-4 py-3 transition-colors",
                form.registrationMode === mode.value
                  ? "border-teal/50 bg-teal/8"
                  : "border-line bg-raised/40 hover:border-fg3/40",
              ].join(" ")}
            >
              <input
                type="radio"
                name="registrationMode"
                value={mode.value}
                checked={form.registrationMode === mode.value}
                onChange={() => update("registrationMode", mode.value)}
                className="mt-0.5 h-4 w-4 shrink-0 accent-[rgb(22_214_199)]"
              />
              <span>
                <span className="block text-[13px] font-medium text-fg">{t(mode.label)}</span>
                <span className="mt-0.5 block text-[12.5px] leading-relaxed text-fg3">{t(mode.hint)}</span>
              </span>
            </label>
          ))}
        </fieldset>

        {form.registrationMode === "domain" ? (
          <Field
            label={t("admin.settingsDomains")}
            hint={t("admin.settingsDomainsHint")}
            htmlFor="allowed-domains"
          >
            <Textarea
              id="allowed-domains"
              value={domains}
              onChange={(event) => setDomains(event.target.value)}
              placeholder="example.com"
              className="font-mono text-[13px]"
            />
          </Field>
        ) : null}

        <div className="space-y-4 border-t border-line-soft pt-5">
          <Toggle
            checked={form.requireEmailVerification}
            onChange={(next) => update("requireEmailVerification", next)}
            label={t("admin.settingsRequireVerification")}
            hint={t("admin.settingsRequireVerificationHint")}
          />
          <Toggle
            checked={form.allowTeamCreation}
            onChange={(next) => update("allowTeamCreation", next)}
            label={t("admin.settingsAllowTeams")}
          />
          <Toggle
            checked={form.maintenanceMode}
            onChange={(next) => update("maintenanceMode", next)}
            label={t("admin.settingsMaintenance")}
            hint={t("admin.settingsMaintenanceHint")}
          />
          {form.maintenanceMode ? (
            <Field label={t("admin.settingsMaintenanceMessage")} htmlFor="maintenance-message">
              <Input
                id="maintenance-message"
                value={form.maintenanceMessage}
                onChange={(event) => update("maintenanceMessage", event.target.value)}
                maxLength={500}
              />
            </Field>
          ) : null}
        </div>

        <div className="grid gap-4 border-t border-line-soft pt-5 sm:grid-cols-2">
          <Field
            label={t("admin.settingsRetention")}
            hint={t("admin.settingsRetentionHint")}
            htmlFor="audit-retention"
          >
            <Input
              id="audit-retention"
              type="number"
              min={0}
              max={3650}
              value={form.auditRetentionDays}
              onChange={(event) => update("auditRetentionDays", Number(event.target.value) || 0)}
            />
          </Field>
          <Field
            label={t("admin.settingsVersions")}
            hint={t("admin.settingsVersionsHint")}
            htmlFor="item-versions"
          >
            <Input
              id="item-versions"
              type="number"
              min={1}
              max={200}
              value={form.itemVersionsKept}
              onChange={(event) => update("itemVersionsKept", Number(event.target.value) || 1)}
            />
          </Field>
        </div>

        <div className="flex justify-end">
          <Button type="submit" variant="primary" loading={pending}>
            {t("common.save")}
          </Button>
        </div>
      </form>
    </Panel>
  );
}

function SmtpPanel({ settings, onSaved }: { settings: AdminSettings; onSaved(): void }) {
  const { t } = useI18n();
  const save = useAction();
  const test = useAction();
  const [form, setForm] = useState(settings.smtp);
  const [password, setPassword] = useState("");
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string } | null>(null);

  useEffect(() => {
    setForm(settings.smtp);
  }, [settings.smtp]);

  const update = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const saved = await save.run(() =>
      api.put("/v1/admin/settings/smtp", {
        enabled: form.enabled,
        host: form.host,
        port: form.port,
        security: form.security,
        user: form.user,
        from: form.from,
        // Omitted rather than sent empty, so saving the other fields does not
        // wipe a password that is already working.
        ...(password ? { password } : {}),
      }),
    );
    if (saved === undefined) return;
    setPassword("");
    onSaved();
  };

  const sendTest = async () => {
    const result = await test.run(() =>
      api.post<{ ok: boolean; stage: string; error?: string }>("/v1/admin/settings/smtp/test", {}),
    );
    if (result) setTestResult({ ok: result.ok, error: result.error });
  };

  return (
    <Panel>
      <PanelHeader title={t("admin.smtpTitle")} description={t("admin.smtpSubtitle")} />
      <form onSubmit={submit} className="space-y-5 px-5 py-5">
        {settings.environmentSmtpConfigured ? (
          <Notice tone="info">{t("admin.smtpFromEnv")}</Notice>
        ) : null}
        {save.error ? <Notice tone="danger">{save.error}</Notice> : null}
        {save.done ? <Notice tone="ok">{t("common.saved")}</Notice> : null}
        {testResult ? (
          testResult.ok ? (
            <Notice tone="ok">{t("admin.smtpTestSuccess")}</Notice>
          ) : (
            <Notice tone="danger">
              {t("admin.smtpTestFailed", { error: testResult.error ?? "unknown" })}
            </Notice>
          )
        ) : null}

        <Toggle
          checked={form.enabled}
          onChange={(next) => update("enabled", next)}
          label={t("admin.smtpEnabled")}
        />

        {form.enabled ? (
          <>
            <div className="grid gap-4 sm:grid-cols-[2fr_1fr]">
              <Field label={t("admin.smtpHost")} htmlFor="smtp-host">
                <Input
                  id="smtp-host"
                  value={form.host}
                  onChange={(event) => update("host", event.target.value)}
                  placeholder="smtp.example.com"
                  required
                />
              </Field>
              <Field label={t("admin.smtpPort")} htmlFor="smtp-port">
                <Input
                  id="smtp-port"
                  type="number"
                  min={1}
                  max={65535}
                  value={form.port}
                  onChange={(event) => update("port", Number(event.target.value) || 587)}
                />
              </Field>
            </div>
            <Field label={t("admin.smtpSecurity")} htmlFor="smtp-security">
              <Select
                id="smtp-security"
                value={form.security}
                onChange={(event) => update("security", event.target.value as typeof form.security)}
              >
                <option value="starttls">STARTTLS (587)</option>
                <option value="tls">TLS (465)</option>
                <option value="none">{t("admin.smtpSecurityNone")}</option>
              </Select>
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t("admin.smtpUser")} htmlFor="smtp-user">
                <Input
                  id="smtp-user"
                  value={form.user}
                  onChange={(event) => update("user", event.target.value)}
                  autoComplete="off"
                />
              </Field>
              <Field
                label={t("admin.smtpPassword")}
                hint={form.passwordSet ? t("admin.smtpPasswordSet") : undefined}
                htmlFor="smtp-password"
              >
                <Input
                  id="smtp-password"
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="new-password"
                  placeholder={form.passwordSet ? "••••••••" : undefined}
                />
              </Field>
            </div>
            <Field label={t("admin.smtpFrom")} htmlFor="smtp-from">
              <Input
                id="smtp-from"
                value={form.from}
                onChange={(event) => update("from", event.target.value)}
                placeholder="Ravelon Sync <sync@example.com>"
              />
            </Field>
          </>
        ) : null}

        <div className="flex flex-wrap justify-end gap-2">
          {form.enabled ? (
            <Button
              icon={<Send className="h-4 w-4" />}
              loading={test.pending}
              onClick={() => void sendTest()}
            >
              {t("admin.smtpTest")}
            </Button>
          ) : null}
          <Button type="submit" variant="primary" loading={save.pending} icon={<Mail className="h-4 w-4" />}>
            {t("common.save")}
          </Button>
        </div>
      </form>
    </Panel>
  );
}
