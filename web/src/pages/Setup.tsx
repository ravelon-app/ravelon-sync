import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { AuthLayout } from "../components/Shell";
import { Button, Field, Input, Notice } from "../components/ui";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useAction } from "../lib/hooks";
import { useI18n } from "../lib/i18n";

/**
 * First run.
 *
 * A deployment with no accounts lets the first registration through and makes
 * it the administrator. That is the only moment the door is open, so this page
 * takes the server name at the same time and closes registration behind it.
 */
export function Setup() {
  const { t } = useI18n();
  const { signUp, reloadConfig } = useAuth();
  const navigate = useNavigate();
  const { run, pending, error } = useAction();

  const [serverName, setServerName] = useState("Ravelon Sync");
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const result = await run(async () => {
      await signUp({ email, password, displayName: displayName.trim() || undefined });
      // Named after the account exists, because only an administrator may
      // write settings. The default stays `invite`, so nobody else walks in.
      await api.put("/v1/admin/settings/platform", {
        serverName: serverName.trim() || "Ravelon Sync",
        registrationMode: "invite",
      });
      await reloadConfig();
      return true;
    });
    if (result) navigate("/", { replace: true });
  };

  return (
    <AuthLayout title={t("setup.title")} subtitle={t("setup.subtitle")} wide>
      <form onSubmit={submit} className="space-y-6">
        {error ? <Notice tone="danger">{error}</Notice> : null}

        <Field label={t("setup.serverName")} hint={t("setup.serverNameHint")} htmlFor="server-name">
          <Input
            id="server-name"
            value={serverName}
            onChange={(event) => setServerName(event.target.value)}
            maxLength={80}
            autoFocus
            required
          />
        </Field>

        <div className="border-t border-line-soft pt-6">
          <p className="label-caps mb-4">{t("setup.adminSection")}</p>
          <div className="space-y-5">
            <Field label={t("common.email")} htmlFor="email">
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="username"
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
            <Field label={t("common.password")} hint={t("auth.passwordHint", { min: 10 })} htmlFor="password">
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="new-password"
                minLength={10}
                required
              />
            </Field>
          </div>
        </div>

        <Notice tone="info">{t("setup.encryptedNote")}</Notice>

        <Button type="submit" variant="primary" loading={pending} className="w-full">
          {t("setup.create")}
        </Button>
      </form>
    </AuthLayout>
  );
}
