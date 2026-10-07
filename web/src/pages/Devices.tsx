import { useState } from "react";
import { Laptop, Monitor, Smartphone, Terminal } from "lucide-react";

import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  LoadingBlock,
  Notice,
  Panel,
  PanelHeader,
  PageHeader,
} from "../components/ui";
import { api } from "../lib/api";
import { getSession } from "../lib/api";
import { useAuth } from "../lib/auth";
import { formatRelative } from "../lib/format";
import { useAction, useAsync, useDocumentTitle } from "../lib/hooks";
import { useI18n } from "../lib/i18n";
import type { Device } from "../lib/types";

function platformIcon(platform: string) {
  if (platform === "ios" || platform === "android") return Smartphone;
  if (platform === "desktop") return Laptop;
  if (platform === "web") return Monitor;
  return Terminal;
}

export function Devices() {
  const { t, locale } = useI18n();
  const { config } = useAuth();
  useDocumentTitle(t("devices.title"), config?.serverName);

  const devices = useAsync((signal) => api.get<{ devices: Device[] }>("/v1/devices", { signal }), []);
  const { run, pending, error } = useAction();
  const [revoking, setRevoking] = useState<Device | null>(null);
  const [revokingAll, setRevokingAll] = useState(false);

  const currentDeviceId = getSession()?.deviceId;
  const list = devices.data?.devices ?? [];
  const others = list.filter((device) => device.id !== currentDeviceId);

  const revoke = async (device: Device) => {
    const removed = await run(() => api.delete(`/v1/devices/${encodeURIComponent(device.id)}`));
    if (removed === undefined) return;
    setRevoking(null);
    devices.reload();
  };

  const revokeAll = async () => {
    const removed = await run(() => api.delete("/v1/devices"));
    if (removed === undefined) return;
    setRevokingAll(false);
    devices.reload();
  };

  return (
    <>
      <PageHeader
        title={t("devices.title")}
        description={t("devices.subtitle")}
        action={
          others.length > 0 ? (
            <Button variant="danger" onClick={() => setRevokingAll(true)}>
              {t("devices.revokeAll")}
            </Button>
          ) : null
        }
      />

      {devices.error ? <Notice tone="danger">{devices.error}</Notice> : null}
      {error ? (
        <Notice tone="danger" className="mb-4">
          {error}
        </Notice>
      ) : null}

      <Panel>
        <PanelHeader title={t("devices.title")} />
        {devices.loading ? (
          <LoadingBlock />
        ) : list.length === 0 ? (
          <EmptyState icon={<Monitor className="h-7 w-7" />} title={t("devices.empty")} />
        ) : (
          <ul className="divide-y divide-line-soft">
            {list.map((device) => {
              const Icon = platformIcon(device.platform);
              const isCurrent = device.id === currentDeviceId;
              return (
                <li key={device.id} className="flex items-center gap-4 px-5 py-4">
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-line bg-raised">
                    <Icon className="h-4 w-4 text-fg3" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 text-[13px] font-medium text-fg">
                      <span className="truncate">{device.name}</span>
                      {isCurrent ? <Badge tone="accent">{t("devices.thisDevice")}</Badge> : null}
                      {device.mfaVerified ? <Badge tone="ok">{t("devices.mfaVerified")}</Badge> : null}
                    </p>
                    <p className="mt-0.5 text-[12px] text-fg3">
                      {device.platform}
                      {device.lastSeenAt
                        ? ` · ${t("devices.lastSeen", { when: formatRelative(device.lastSeenAt, locale) })}`
                        : ""}
                    </p>
                  </div>
                  {!isCurrent ? (
                    <Button size="sm" variant="ghost" onClick={() => setRevoking(device)}>
                      {t("devices.revoke")}
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </Panel>

      <Dialog
        open={Boolean(revoking)}
        onClose={() => setRevoking(null)}
        tone="danger"
        title={t("devices.revoke")}
        description={t("devices.revokeBody", { name: revoking?.name ?? "" })}
        footer={
          <>
            <Button onClick={() => setRevoking(null)}>{t("common.cancel")}</Button>
            <Button variant="danger" loading={pending} onClick={() => revoking && void revoke(revoking)}>
              {t("devices.revoke")}
            </Button>
          </>
        }
      />

      <Dialog
        open={revokingAll}
        onClose={() => setRevokingAll(false)}
        tone="danger"
        title={t("devices.revokeAll")}
        description={t("devices.revokeBody", { name: `${others.length}` })}
        footer={
          <>
            <Button onClick={() => setRevokingAll(false)}>{t("common.cancel")}</Button>
            <Button variant="danger" loading={pending} onClick={() => void revokeAll()}>
              {t("common.confirm")}
            </Button>
          </>
        }
      />
    </>
  );
}
