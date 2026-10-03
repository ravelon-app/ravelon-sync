import { useState } from "react";
import { Plus, Ticket } from "lucide-react";

import {
  Badge,
  Button,
  CopyField,
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
import { useAuth } from "../../lib/auth";
import { formatRelative } from "../../lib/format";
import { useAction, useAsync, useDocumentTitle } from "../../lib/hooks";
import { useI18n } from "../../lib/i18n";
import type { AccountInvite, CreatedInvite, UserRole } from "../../lib/types";

const STATUS_TONES = {
  pending: "accent",
  used: "neutral",
  revoked: "neutral",
  expired: "warn",
} as const;

export function AdminInvites() {
  const { t, locale } = useI18n();
  const { config } = useAuth();
  useDocumentTitle(t("admin.invitesTitle"), config?.serverName);

  const invites = useAsync(
    (signal) => api.get<{ invites: AccountInvite[] }>("/v1/admin/invites", { signal }),
    [],
  );
  const { run, pending, error } = useAction();
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreatedInvite | null>(null);

  const revoke = async (id: string) => {
    await run(() => api.delete(`/v1/admin/invites/${encodeURIComponent(id)}`));
    invites.reload();
  };

  const list = invites.data?.invites ?? [];

  return (
    <>
      <PageHeader
        title={t("admin.invitesTitle")}
        description={t("admin.invitesSubtitle")}
        action={
          <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>
            {t("admin.inviteCreate")}
          </Button>
        }
      />

      {invites.error ? <Notice tone="danger" className="mb-4">{invites.error}</Notice> : null}
      {error ? <Notice tone="danger" className="mb-4">{error}</Notice> : null}

      <Panel>
        {invites.loading ? (
          <LoadingBlock />
        ) : list.length === 0 ? (
          <EmptyState icon={<Ticket className="h-7 w-7" />} title={t("admin.noInvites")} />
        ) : (
          <TableWrap>
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-line-soft">
                  <Th>{t("common.email")}</Th>
                  <Th>{t("common.role")}</Th>
                  <Th>{t("common.status")}</Th>
                  <Th>{t("admin.inviteNote")}</Th>
                  <Th>{t("common.created")}</Th>
                  <Th className="text-right">{t("common.actions")}</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line-soft">
                {list.map((invite) => (
                  <tr key={invite.id} className="transition-colors hover:bg-raised/40">
                    <Td className="text-fg">{invite.email || t("admin.inviteAnyone")}</Td>
                    <Td>{invite.role === "admin" ? t("admin.roleAdmin") : t("teams.roleMember")}</Td>
                    <Td>
                      <Badge tone={STATUS_TONES[invite.status]}>{invite.status}</Badge>
                      {invite.usedByEmail ? (
                        <span className="mt-0.5 block text-[12px] text-fg3">{invite.usedByEmail}</span>
                      ) : null}
                    </Td>
                    <Td className="max-w-48 truncate">{invite.note || "—"}</Td>
                    <Td className="whitespace-nowrap">{formatRelative(invite.createdAt, locale)}</Td>
                    <Td className="text-right">
                      {invite.status === "pending" ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          loading={pending}
                          onClick={() => void revoke(invite.id)}
                        >
                          {t("teams.inviteRevoke")}
                        </Button>
                      ) : null}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Panel>

      <CreateInviteDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(invite) => {
          setCreating(false);
          setCreated(invite);
          invites.reload();
        }}
      />

      <Dialog
        open={Boolean(created)}
        onClose={() => setCreated(null)}
        title={t("admin.inviteCreated")}
        footer={<Button onClick={() => setCreated(null)}>{t("common.close")}</Button>}
      >
        {created ? (
          <div className="space-y-4">
            {created.emailDelivered ? (
              <Notice tone="ok">{t("admin.inviteMailSent", { email: created.email })}</Notice>
            ) : created.email ? (
              <Notice tone="warn">
                {created.emailError === "smtp_not_configured"
                  ? t("teams.inviteNoMail")
                  : t("admin.inviteMailFailed", { reason: created.emailError ?? "unknown" })}
              </Notice>
            ) : (
              <Notice tone="info">{t("admin.inviteNoMail")}</Notice>
            )}
            <CopyField value={created.inviteUrl} label={t("admin.inviteLink")} />
            <p className="text-[12.5px] text-fg3">{t("admin.inviteLinkOnce")}</p>
          </div>
        ) : null}
      </Dialog>
    </>
  );
}

function CreateInviteDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose(): void;
  onCreated(invite: CreatedInvite): void;
}) {
  const { t } = useI18n();
  const { run, pending, error } = useAction();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<UserRole>("user");
  const [note, setNote] = useState("");
  const [expiresInDays, setExpiresInDays] = useState(14);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const invite = await run(() =>
      api.post<CreatedInvite>("/v1/admin/invites", {
        // An empty address deliberately means "a link anyone can use once",
        // which is what an operator wants when they have no mail set up.
        ...(email.trim() ? { email: email.trim() } : {}),
        role,
        note: note.trim(),
        expiresInDays,
      }),
    );
    if (!invite) return;
    setEmail("");
    setNote("");
    onCreated(invite);
  };

  return (
    <Dialog open={open} onClose={onClose} title={t("admin.inviteCreate")}>
      <form onSubmit={submit} className="space-y-4">
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <Field label={t("admin.inviteEmailLabel")} hint={t("admin.inviteEmailHint")} htmlFor="invite-email">
          <Input
            id="invite-email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("common.role")} htmlFor="invite-role">
            <Select
              id="invite-role"
              value={role}
              onChange={(event) => setRole(event.target.value as UserRole)}
            >
              <option value="user">{t("teams.roleMember")}</option>
              <option value="admin">{t("admin.roleAdmin")}</option>
            </Select>
          </Field>
          <Field label={t("admin.inviteExpiry")} htmlFor="invite-expiry">
            <Input
              id="invite-expiry"
              type="number"
              min={1}
              max={90}
              value={expiresInDays}
              onChange={(event) => setExpiresInDays(Number(event.target.value) || 14)}
            />
          </Field>
        </div>
        <Field label={`${t("admin.inviteNote")} (${t("common.optional")})`} htmlFor="invite-note">
          <Input
            id="invite-note"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            maxLength={200}
          />
        </Field>
        <div className="flex justify-end gap-2 pt-2">
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button type="submit" variant="primary" loading={pending}>
            {t("common.create")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
