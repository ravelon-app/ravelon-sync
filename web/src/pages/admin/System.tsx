import { AlertTriangle, CheckCircle2 } from "lucide-react";

import { Badge, DataList, LoadingBlock, Notice, Panel, PanelHeader, PageHeader } from "../../components/ui";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { formatBytes, formatUptime } from "../../lib/format";
import { useAsync, useDocumentTitle } from "../../lib/hooks";
import { useI18n } from "../../lib/i18n";
import type { SystemInfo } from "../../lib/types";

export function AdminSystem() {
  const { t } = useI18n();
  const { config } = useAuth();
  useDocumentTitle(t("admin.systemTitle"), config?.serverName);

  const system = useAsync((signal) => api.get<SystemInfo>("/v1/admin/system", { signal }), []);

  return (
    <>
      <PageHeader title={t("admin.systemTitle")} />

      {system.error ? <Notice tone="danger">{system.error}</Notice> : null}

      {system.loading || !system.data ? (
        <Panel>
          <LoadingBlock />
        </Panel>
      ) : (
        <div className="grid gap-6 lg:grid-cols-2">
          <Panel>
            <PanelHeader title={t("admin.systemTitle")} />
            <DataList
              rows={[
                { label: t("admin.systemVersion"), value: <Mono>{system.data.version}</Mono> },
                { label: t("admin.systemNode"), value: <Mono>{system.data.nodeVersion}</Mono> },
                {
                  label: t("admin.systemDatabase"),
                  value: (
                    <Badge tone={system.data.database === "postgres" ? "accent" : "neutral"}>
                      {system.data.database}
                    </Badge>
                  ),
                },
                { label: "NODE_ENV", value: <Mono>{system.data.nodeEnv}</Mono> },
                {
                  label: t("admin.systemUptime"),
                  value: <Mono>{formatUptime(system.data.uptimeSeconds)}</Mono>,
                },
                {
                  label: t("admin.systemPublicUrl"),
                  value: system.data.publicUrl ? (
                    <Mono>{system.data.publicUrl}</Mono>
                  ) : (
                    <span className="text-fg3">{t("common.none")}</span>
                  ),
                },
              ]}
            />
          </Panel>

          <Panel>
            <PanelHeader title={t("admin.settingsGeneral")} />
            <DataList
              rows={[
                {
                  label: t("admin.systemStorageLimit"),
                  value: <Mono>{formatBytes(system.data.limits.vaultStorageBytes)}</Mono>,
                },
                {
                  label: t("admin.systemVaultLimit"),
                  value: <Mono>{system.data.limits.vaultsPerUser}</Mono>,
                },
                {
                  label: t("admin.systemRateLimit"),
                  value: system.data.rateLimitEnabled ? (
                    <Badge tone="ok">{t("admin.systemEnabled")}</Badge>
                  ) : (
                    <Badge tone="warn">{t("admin.systemDisabled")}</Badge>
                  ),
                },
                {
                  label: t("admin.smtpTitle"),
                  value: system.data.smtpConfigured ? (
                    <Badge tone="ok">{t("admin.systemEnabled")}</Badge>
                  ) : (
                    <Badge>{t("admin.systemDisabled")}</Badge>
                  ),
                },
              ]}
            />
          </Panel>

          <Panel className="lg:col-span-2">
            <PanelHeader title={t("admin.systemWarnings")} />
            <div className="px-5 py-4">
              {system.data.warnings.length === 0 ? (
                <p className="flex items-center gap-2 text-[13px] text-ok">
                  <CheckCircle2 className="h-4 w-4" />
                  {t("admin.systemHealthy")}
                </p>
              ) : (
                <ul className="space-y-2.5">
                  {system.data.warnings.map((warning) => (
                    <li
                      key={warning}
                      className="flex gap-3 rounded-lg border border-warn/30 bg-warn/8 px-4 py-3 text-[13px] leading-relaxed text-fg2"
                    >
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warn" />
                      {warning}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Panel>
        </div>
      )}
    </>
  );
}

function Mono({ children }: { children: React.ReactNode }) {
  return <code className="font-mono text-[12.5px] text-fg">{children}</code>;
}
