import { useState } from "react";
import { KeyRound, MoreHorizontal, Search, ShieldCheck, ShieldOff, Trash2, UserCog } from "lucide-react";

import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  Field,
  Input,
  LoadingBlock,
  Notice,
  Panel,
  PageHeader,
  Select,
  TableWrap,
  Td,
  Th,
} from "../../components/ui";
import { api } from "../../lib/api";
import { useAccount, useAuth } from "../../lib/auth";
import { formatRelative, personLabel } from "../../lib/format";
import { useAction, useAsync, useDocumentTitle } from "../../lib/hooks";
import { useI18n } from "../../lib/i18n";
import type { AdminUser } from "../../lib/types";

type Filter = "all" | "admin" | "disabled";

export function AdminUsers() {
  const { t, locale } = useI18n();
  const { config } = useAuth();
  const me = useAccount();
  useDocumentTitle(t("admin.usersTitle"), config?.serverName);

  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [open, setOpen] = useState<AdminUser | null>(null);

  const users = useAsync(
    (signal) => {
      const query = new URLSearchParams({ limit: "200" });
      if (search.trim()) query.set("search", search.trim());
      if (filter === "admin") query.set("role", "admin");
      if (filter === "disabled") query.set("status", "disabled");
      return api.get<{ total: number; users: AdminUser[] }>(`/v1/admin/users?${query}`, { signal });
    },
    [search, filter],
  );

  const list = users.data?.users ?? [];

  return (
    <>
      <PageHeader title={t("admin.usersTitle")} description={t("admin.usersSubtitle")} />

      <div className="mb-4 flex flex-wrap gap-3">
        <div className="relative min-w-56 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg3" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("admin.userSearch")}
            className="pl-9"
            aria-label={t("admin.userSearch")}
          />
        </div>
        <Select
          value={filter}
          onChange={(event) => setFilter(event.target.value as Filter)}
          aria-label={t("common.status")}
          className="w-auto"
        >
          <option value="all">{t("admin.filterAll")}</option>
          <option value="admin">{t("admin.filterAdmins")}</option>
          <option value="disabled">{t("admin.filterDisabled")}</option>
        </Select>
      </div>

      {users.error ? <Notice tone="danger" className="mb-4">{users.error}</Notice> : null}

      <Panel>
        {users.loading ? (
          <LoadingBlock />
        ) : list.length === 0 ? (
          <EmptyState title={t("admin.noUsers")} />
        ) : (
          <TableWrap>
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-line-soft">
                  <Th>{t("common.email")}</Th>
                  <Th>{t("common.role")}</Th>
                  <Th>{t("security.mfaTitle")}</Th>
                  <Th className="text-right">{t("nav.vaults")}</Th>
                  <Th>{t("devices.lastSeen", { when: "" })}</Th>
                  <Th className="text-right">{t("common.actions")}</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line-soft">
                {list.map((user) => (
                  <tr key={user.id} className="transition-colors hover:bg-raised/40">
                    <Td>
                      <span className="block font-medium text-fg">{personLabel(user)}</span>
                      {user.displayName ? (
                        <span className="mt-0.5 block text-[12px] text-fg3">{user.email}</span>
                      ) : null}
                    </Td>
                    <Td>
                      <div className="flex flex-wrap gap-1.5">
                        {user.role === "admin" ? (
                          <Badge tone="accent">{t("nav.admin")}</Badge>
                        ) : (
                          <Badge>{t("teams.roleMember")}</Badge>
                        )}
                        {user.disabled ? <Badge tone="danger">{t("admin.filterDisabled")}</Badge> : null}
                        {!user.emailVerified ? (
                          <Badge tone="warn">{t("account.emailUnverified")}</Badge>
                        ) : null}
                      </div>
                    </Td>
                    <Td>
                      {user.mfaEnabled ? (
                        <span className="inline-flex items-center gap-1.5 text-ok">
                          <ShieldCheck className="h-3.5 w-3.5" />
                          {t("admin.systemEnabled")}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 text-fg3">
                          <ShieldOff className="h-3.5 w-3.5" />
                          {t("admin.systemDisabled")}
                        </span>
                      )}
                    </Td>
                    <Td className="text-right font-mono tabular-nums">{user.vaults}</Td>
                    <Td className="whitespace-nowrap">
                      {user.lastSeenAt ? formatRelative(user.lastSeenAt, locale) : t("common.never")}
                    </Td>
                    <Td className="text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={<MoreHorizontal className="h-4 w-4" />}
                        onClick={() => setOpen(user)}
                        aria-label={t("common.actions")}
                      />
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Panel>

      <UserActionsDialog
        user={open}
        currentUserId={me.user.id}
        onClose={() => setOpen(null)}
        onChanged={users.reload}
      />
    </>
  );
}

function UserActionsDialog({
  user,
  currentUserId,
  onClose,
  onChanged,
}: {
  user: AdminUser | null;
  currentUserId: string;
  onClose(): void;
  onChanged(): void;
}) {
  const { t } = useI18n();
  const { run, pending, error } = useAction();
  const [confirming, setConfirming] = useState<"disable" | "delete" | "password" | "mfa" | null>(null);
  const [reason, setReason] = useState("");
  const [newPassword, setNewPassword] = useState("");

  if (!user) return null;
  const isSelf = user.id === currentUserId;

  const patch = async (body: Record<string, unknown>) => {
    const updated = await run(() => api.patch(`/v1/admin/users/${encodeURIComponent(user.id)}`, body));
    if (updated === undefined) return;
    setConfirming(null);
    setReason("");
    onChanged();
    onClose();
  };

  const act = async (operation: () => Promise<unknown>) => {
    const result = await run(operation);
    if (result === undefined) return;
    setConfirming(null);
    setNewPassword("");
    onChanged();
    onClose();
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={personLabel(user)}
      description={user.displayName ? user.email : undefined}
      footer={<Button onClick={onClose}>{t("common.close")}</Button>}
    >
      <div className="space-y-4">
        {error ? <Notice tone="danger">{error}</Notice> : null}
        {isSelf ? <Notice tone="info">{t("common.you")}</Notice> : null}

        {confirming === "disable" ? (
          <div className="space-y-3">
            <Notice tone="warn">{t("admin.userDisableBody", { email: user.email })}</Notice>
            <Field label={t("admin.userDisableReason")} htmlFor="disable-reason">
              <Input
                id="disable-reason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                maxLength={200}
              />
            </Field>
            <div className="flex justify-end gap-2">
              <Button onClick={() => setConfirming(null)}>{t("common.cancel")}</Button>
              <Button
                variant="danger"
                loading={pending}
                onClick={() => void patch({ disabled: true, disabledReason: reason.trim() || undefined })}
              >
                {t("admin.userDisable")}
              </Button>
            </div>
          </div>
        ) : confirming === "password" ? (
          <div className="space-y-3">
            <Notice tone="warn">{t("admin.userSetPasswordBody")}</Notice>
            <Field
              label={t("account.newPassword")}
              hint={t("auth.passwordHint", { min: 10 })}
              htmlFor="admin-new-password"
            >
              <Input
                id="admin-new-password"
                type="password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                autoComplete="new-password"
                minLength={10}
              />
            </Field>
            <div className="flex justify-end gap-2">
              <Button onClick={() => setConfirming(null)}>{t("common.cancel")}</Button>
              <Button
                variant="primary"
                loading={pending}
                disabled={newPassword.length < 10}
                onClick={() =>
                  void act(() =>
                    api.post(`/v1/admin/users/${encodeURIComponent(user.id)}/password`, { newPassword }),
                  )
                }
              >
                {t("common.confirm")}
              </Button>
            </div>
          </div>
        ) : confirming === "mfa" ? (
          <div className="space-y-3">
            <Notice tone="warn">{t("admin.userResetMfaBody", { email: user.email })}</Notice>
            <div className="flex justify-end gap-2">
              <Button onClick={() => setConfirming(null)}>{t("common.cancel")}</Button>
              <Button
                variant="danger"
                loading={pending}
                onClick={() => void act(() => api.delete(`/v1/admin/users/${encodeURIComponent(user.id)}/mfa`))}
              >
                {t("admin.userResetMfa")}
              </Button>
            </div>
          </div>
        ) : confirming === "delete" ? (
          <div className="space-y-3">
            <Notice tone="danger">{t("admin.userDeleteBody", { email: user.email })}</Notice>
            <div className="flex justify-end gap-2">
              <Button onClick={() => setConfirming(null)}>{t("common.cancel")}</Button>
              <Button
                variant="danger"
                loading={pending}
                onClick={() => void act(() => api.delete(`/v1/admin/users/${encodeURIComponent(user.id)}`))}
              >
                {t("common.delete")}
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <ActionRow
              icon={<UserCog className="h-4 w-4" />}
              label={user.role === "admin" ? t("admin.userRemoveAdmin") : t("admin.userMakeAdmin")}
              onClick={() => void patch({ role: user.role === "admin" ? "user" : "admin" })}
              disabled={pending}
            />
            <ActionRow
              icon={<KeyRound className="h-4 w-4" />}
              label={t("admin.userSetPassword")}
              onClick={() => setConfirming("password")}
            />
            {user.mfaEnabled ? (
              <ActionRow
                icon={<ShieldOff className="h-4 w-4" />}
                label={t("admin.userResetMfa")}
                onClick={() => setConfirming("mfa")}
              />
            ) : null}
            {user.disabled ? (
              <ActionRow
                icon={<ShieldCheck className="h-4 w-4" />}
                label={t("admin.userEnable")}
                onClick={() => void patch({ disabled: false })}
                disabled={pending}
              />
            ) : (
              <ActionRow
                icon={<ShieldOff className="h-4 w-4" />}
                label={t("admin.userDisable")}
                onClick={() => setConfirming("disable")}
                disabled={isSelf}
              />
            )}
            <ActionRow
              icon={<Trash2 className="h-4 w-4" />}
              label={t("admin.userDelete")}
              onClick={() => setConfirming("delete")}
              disabled={isSelf}
              danger
            />
          </div>
        )}
      </div>
    </Dialog>
  );
}

function ActionRow({
  icon,
  label,
  onClick,
  disabled,
  danger,
}: {
  icon: React.ReactNode;
  label: string;
  onClick(): void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={[
        "flex w-full items-center gap-3 rounded-lg border border-line px-3.5 py-2.5 text-left text-[13px]",
        "transition-colors disabled:cursor-not-allowed disabled:opacity-40",
        danger
          ? "text-danger hover:border-danger/50 hover:bg-danger/8"
          : "text-fg2 hover:border-fg3/50 hover:bg-raised hover:text-fg",
      ].join(" ")}
    >
      <span className="shrink-0">{icon}</span>
      {label}
    </button>
  );
}
