import { Link } from "react-router-dom";
import { Database, Monitor, Users } from "lucide-react";

import {
  Badge,
  Button,
  CopyField,
  DataList,
  Notice,
  Panel,
  PanelHeader,
  PageHeader,
  Stat,
} from "../components/ui";
import { api } from "../lib/api";
import { useAccount, useAuth } from "../lib/auth";
import { formatBytes, formatNumber, formatRelative } from "../lib/format";
import { useAsync, useDocumentTitle } from "../lib/hooks";
import { useI18n } from "../lib/i18n";
import type { Device, Team, Vault } from "../lib/types";

export function Overview() {
  const { t, locale } = useI18n();
  const { config } = useAuth();
  const account = useAccount();
  useDocumentTitle(t("overview.title"), config?.serverName);

  const vaults = useAsync((signal) => api.get<{ vaults: Vault[] }>("/v1/vaults", { signal }), []);
  const teams = useAsync((signal) => api.get<{ teams: Team[] }>("/v1/teams", { signal }), []);
  const devices = useAsync((signal) => api.get<{ devices: Device[] }>("/v1/devices", { signal }), []);

  const vaultList = vaults.data?.vaults ?? [];
  const records = vaultList.reduce((total, vault) => total + (vault.itemCount ?? 0), 0);
  const bytes = vaultList.reduce((total, vault) => total + (vault.storageBytes ?? 0), 0);

  // The origin the browser reached this page on is exactly what a Ravelon
  // client needs to type, so it is offered rather than described.
  const serverUrl = typeof window === "undefined" ? "" : window.location.origin;

  return (
    <>
      <PageHeader
        title={t("overview.title")}
        description={t("overview.greeting", { email: account.user.email })}
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label={t("overview.yourVaults")}
          value={formatNumber(vaultList.length, locale)}
          hint={t("vaults.storage", { size: formatBytes(bytes) })}
        />
        <Stat label={t("overview.encryptedRecords")} value={formatNumber(records, locale)} />
        <Stat label={t("overview.yourTeams")} value={formatNumber(teams.data?.teams.length ?? 0, locale)} />
        <Stat
          label={t("overview.yourDevices")}
          value={formatNumber(devices.data?.devices.length ?? 0, locale)}
        />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <div className="space-y-6">
          <Panel>
            <PanelHeader
              title={t("overview.connectTitle")}
              description={t("overview.connectBody")}
              action={
                <Link to="/devices">
                  <Button size="sm" icon={<Monitor className="h-4 w-4" />}>
                    {t("nav.devices")}
                  </Button>
                </Link>
              }
            />
            <div className="px-5 py-4">
              <CopyField value={serverUrl} label={t("overview.connectUrlLabel")} />
            </div>
          </Panel>

          <Panel>
            <PanelHeader
              title={t("overview.yourVaults")}
              action={
                <Link to="/vaults">
                  <Button size="sm" icon={<Database className="h-4 w-4" />}>
                    {t("nav.vaults")}
                  </Button>
                </Link>
              }
            />
            {vaultList.length === 0 ? (
              <p className="px-5 py-6 text-[13px] text-fg3">{t("vaults.empty")}</p>
            ) : (
              <ul className="divide-y divide-line-soft">
                {vaultList.slice(0, 6).map((vault) => (
                  <li key={vault.id} className="flex items-center justify-between gap-4 px-5 py-3">
                    <div className="min-w-0">
                      <p className="truncate text-[13px] font-medium text-fg">{vault.name}</p>
                      <p className="mt-0.5 text-[12px] text-fg3">
                        {t((vault.itemCount ?? 0) === 1 ? "vaults.recordsOne" : "vaults.records", {
                          count: formatNumber(vault.itemCount ?? 0, locale),
                        })}
                        {" · "}
                        {formatRelative(vault.updatedAt, locale)}
                      </p>
                    </div>
                    <Badge tone={vault.kind === "team" ? "accent" : "neutral"}>
                      {vault.kind === "team" ? t("vaults.team") : t("vaults.personal")}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>

        <div className="space-y-6">
          <Panel>
            <PanelHeader title={t("overview.securityTitle")} />
            <div className="space-y-3 px-5 py-4">
              {account.mfaEnabled ? (
                <Notice tone="ok">{t("overview.securityMfaOn")}</Notice>
              ) : (
                <Notice tone="warn">
                  <div className="flex flex-col items-start gap-2.5">
                    {t("overview.securityMfaOff")}
                    <Link to="/security">
                      <Button size="sm" variant="primary">
                        {t("security.mfaEnable")}
                      </Button>
                    </Link>
                  </div>
                </Notice>
              )}
              <DataList
                rows={[
                  {
                    label: t("common.email"),
                    value: account.user.emailVerified ? (
                      <Badge tone="ok">{t("account.emailVerified")}</Badge>
                    ) : (
                      <Badge tone="warn">{t("account.emailUnverified")}</Badge>
                    ),
                  },
                  {
                    label: t("common.role"),
                    value: account.user.role === "admin" ? t("admin.roleAdmin") : t("teams.roleMember"),
                  },
                ]}
              />
            </div>
          </Panel>

          <Panel>
            <PanelHeader
              title={t("overview.yourTeams")}
              action={
                <Link to="/teams">
                  <Button size="sm" icon={<Users className="h-4 w-4" />}>
                    {t("nav.teams")}
                  </Button>
                </Link>
              }
            />
            {(teams.data?.teams.length ?? 0) === 0 ? (
              <p className="px-5 py-6 text-[13px] text-fg3">{t("teams.empty")}</p>
            ) : (
              <ul className="divide-y divide-line-soft">
                {teams.data!.teams.map((team) => (
                  <li key={team.id} className="flex items-center justify-between gap-4 px-5 py-3">
                    <p className="truncate text-[13px] font-medium text-fg">{team.name}</p>
                    <span className="shrink-0 text-[12px] text-fg3">
                      {t(team.members === 1 ? "teams.memberCountOne" : "teams.memberCount", {
                        count: team.members,
                      })}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>
    </>
  );
}
