import { useState } from "react";
import { Database, ScrollText } from "lucide-react";

import {
  Badge,
  EmptyState,
  Input,
  LoadingBlock,
  Notice,
  Panel,
  PanelHeader,
  PageHeader,
  Stat,
  TableWrap,
  Td,
  Th,
} from "../../components/ui";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { formatBytes, formatNumber, formatRelative } from "../../lib/format";
import { useAsync, useDocumentTitle } from "../../lib/hooks";
import { useI18n } from "../../lib/i18n";
import type { AdminVault, AuditEntry } from "../../lib/types";

export function AdminVaults() {
  const { t, locale } = useI18n();
  const { config } = useAuth();
  useDocumentTitle(t("admin.vaultsTitle"), config?.serverName);

  const overview = useAsync(
    (signal) =>
      api.get<{
        users: { total: number; admins: number; disabled: number; activeLastWeek: number };
        teams: number;
        vaults: number;
        syncItems: number;
        devices: number;
        encryptedBytes: number;
      }>("/v1/admin/overview", { signal }),
    [],
  );
  const vaults = useAsync(
    (signal) => api.get<{ total: number; vaults: AdminVault[] }>("/v1/admin/vaults?limit=200", { signal }),
    [],
  );

  const list = vaults.data?.vaults ?? [];

  return (
    <>
      <PageHeader title={t("admin.vaultsTitle")} description={t("admin.vaultsSubtitle")} />

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label={t("admin.usersTitle")} value={formatNumber(overview.data?.users.total ?? 0, locale)} />
        <Stat label={t("nav.teams")} value={formatNumber(overview.data?.teams ?? 0, locale)} />
        <Stat
          label={t("overview.encryptedRecords")}
          value={formatNumber(overview.data?.syncItems ?? 0, locale)}
        />
        <Stat
          label={t("admin.vaultStorage")}
          value={formatBytes(overview.data?.encryptedBytes ?? 0)}
        />
      </div>

      {vaults.error ? <Notice tone="danger" className="mb-4">{vaults.error}</Notice> : null}

      <Panel>
        {vaults.loading ? (
          <LoadingBlock />
        ) : list.length === 0 ? (
          <EmptyState icon={<Database className="h-7 w-7" />} title={t("admin.noVaults")} />
        ) : (
          <TableWrap>
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-line-soft">
                  <Th>{t("common.name")}</Th>
                  <Th>{t("admin.vaultOwner")}</Th>
                  <Th className="text-right">{t("vaults.members")}</Th>
                  <Th className="text-right">{t("admin.vaultRecords")}</Th>
                  <Th className="text-right">{t("admin.vaultStorage")}</Th>
                  <Th>{t("vaults.lastActivity")}</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line-soft">
                {list.map((vault) => (
                  <tr key={vault.id} className="transition-colors hover:bg-raised/40">
                    <Td>
                      <span className="flex items-center gap-2">
                        <span className="font-medium text-fg">{vault.name}</span>
                        <Badge tone={vault.kind === "team" ? "accent" : "neutral"}>{vault.kind}</Badge>
                      </span>
                      {vault.teamName ? (
                        <span className="mt-0.5 block text-[12px] text-fg3">{vault.teamName}</span>
                      ) : null}
                    </Td>
                    <Td>{vault.ownerEmail ?? "—"}</Td>
                    <Td className="text-right font-mono tabular-nums">{vault.members}</Td>
                    <Td className="text-right font-mono tabular-nums">
                      {formatNumber(vault.items, locale)}
                    </Td>
                    <Td className="text-right font-mono tabular-nums">{formatBytes(vault.storageBytes)}</Td>
                    <Td className="whitespace-nowrap">{formatRelative(vault.updatedAt, locale)}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Panel>
    </>
  );
}

export function AdminAudit() {
  const { t, locale } = useI18n();
  const { config } = useAuth();
  useDocumentTitle(t("admin.auditTitle"), config?.serverName);

  const [action, setAction] = useState("");
  const entries = useAsync(
    (signal) => {
      const query = new URLSearchParams({ limit: "200" });
      if (action.trim()) query.set("action", action.trim());
      return api.get<{ total: number; entries: AuditEntry[] }>(`/v1/admin/audit?${query}`, { signal });
    },
    [action],
  );

  const list = entries.data?.entries ?? [];

  return (
    <>
      <PageHeader title={t("admin.auditTitle")} description={t("admin.auditSubtitle")} />

      <div className="mb-4 max-w-sm">
        <Input
          value={action}
          onChange={(event) => setAction(event.target.value)}
          placeholder={t("admin.auditFilter")}
          aria-label={t("admin.auditFilter")}
        />
      </div>

      {entries.error ? <Notice tone="danger" className="mb-4">{entries.error}</Notice> : null}

      <Panel>
        <PanelHeader
          title={t("admin.auditTitle")}
          description={
            entries.data ? t(entries.data.total === 1 ? "admin.auditCountOne" : "admin.auditCount", { count: formatNumber(entries.data.total, locale) }) : undefined
          }
        />
        {entries.loading ? (
          <LoadingBlock />
        ) : list.length === 0 ? (
          <EmptyState icon={<ScrollText className="h-7 w-7" />} title={t("admin.noAudit")} />
        ) : (
          <TableWrap>
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-line-soft">
                  <Th>{t("admin.auditWhen")}</Th>
                  <Th>{t("admin.auditAction")}</Th>
                  <Th>{t("admin.auditActor")}</Th>
                  <Th>{t("common.status")}</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line-soft">
                {list.map((entry) => (
                  <tr key={entry.id} className="transition-colors hover:bg-raised/40">
                    <Td className="whitespace-nowrap">{formatRelative(entry.createdAt, locale)}</Td>
                    <Td>
                      <code className="font-mono text-[12px] text-fg">{entry.action}</code>
                      {entry.target ? (
                        <span className="mt-0.5 block font-mono text-[11px] text-fg3">{entry.target}</span>
                      ) : null}
                    </Td>
                    <Td>
                      <span className="block">{entry.actorEmail ?? "—"}</span>
                      {entry.ip ? (
                        <span className="mt-0.5 block font-mono text-[11px] text-fg3">{entry.ip}</span>
                      ) : null}
                    </Td>
                    <Td>
                      {entry.detail ? (
                        <code className="block max-w-64 truncate font-mono text-[11.5px] text-fg3">
                          {JSON.stringify(entry.detail)}
                        </code>
                      ) : (
                        "—"
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Panel>
    </>
  );
}
