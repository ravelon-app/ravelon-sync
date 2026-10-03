import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Crown, Plus, Trash2, UserPlus, Users } from "lucide-react";

import { AuthLayout } from "../components/Shell";
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
  PanelHeader,
  PageHeader,
  Select,
} from "../components/ui";
import { api } from "../lib/api";
import { useAccount, useAuth } from "../lib/auth";
import { formatRelative, personLabel } from "../lib/format";
import { useAction, useAsync, useDocumentTitle } from "../lib/hooks";
import { useI18n } from "../lib/i18n";
import type {
  CreatedTeamInvite,
  Team,
  TeamInvite,
  TeamMember,
  TeamRole,
  VaultRole,
} from "../lib/types";

export function Teams() {
  const { t } = useI18n();
  const { config } = useAuth();
  useDocumentTitle(t("teams.title"), config?.serverName);

  const teams = useAsync((signal) => api.get<{ teams: Team[] }>("/v1/teams", { signal }), []);
  const [creating, setCreating] = useState(false);
  const [openTeam, setOpenTeam] = useState<Team | null>(null);

  const list = teams.data?.teams ?? [];

  return (
    <>
      <PageHeader
        title={t("teams.title")}
        description={t("teams.subtitle")}
        action={
          <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>
            {t("teams.create")}
          </Button>
        }
      />

      {teams.error ? <Notice tone="danger">{teams.error}</Notice> : null}

      {teams.loading ? (
        <Panel>
          <LoadingBlock />
        </Panel>
      ) : list.length === 0 ? (
        <Panel>
          <EmptyState icon={<Users className="h-7 w-7" />} title={t("teams.empty")} />
        </Panel>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {list.map((team) => (
            <Panel key={team.id} className="flex flex-col">
              <PanelHeader
                title={
                  <span className="flex items-center gap-2">
                    {team.name}
                    {team.role === "owner" ? <Crown className="h-3.5 w-3.5 text-teal" /> : null}
                  </span>
                }
                description={t(team.members === 1 ? "teams.memberCountOne" : "teams.memberCount", { count: team.members })}
              />
              <div className="flex-1 px-5 py-4">
                <p className="label-caps mb-2">{t("nav.vaults")}</p>
                <ul className="space-y-1.5">
                  {team.vaults.map((vault) => (
                    <li key={vault.id} className="flex items-center justify-between gap-3">
                      <span className="truncate text-[13px] text-fg2">{vault.name}</span>
                      <Badge tone="neutral">{vault.role}</Badge>
                    </li>
                  ))}
                  {team.vaults.length === 0 ? (
                    <li className="text-[13px] text-fg3">{t("common.none")}</li>
                  ) : null}
                </ul>
              </div>
              <div className="border-t border-line-soft px-5 py-3">
                <Button size="sm" className="w-full" onClick={() => setOpenTeam(team)}>
                  {t("vaults.members")}
                </Button>
              </div>
            </Panel>
          ))}
        </div>
      )}

      <CreateTeamDialog open={creating} onClose={() => setCreating(false)} onCreated={teams.reload} />
      <TeamDetailDialog team={openTeam} onClose={() => setOpenTeam(null)} onChanged={teams.reload} />
    </>
  );
}

function CreateTeamDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose(): void;
  onCreated(): void;
}) {
  const { t } = useI18n();
  const { run, pending, error } = useAction();
  const [name, setName] = useState("");
  const [vaultName, setVaultName] = useState("");

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const created = await run(() =>
      api.post("/v1/teams", {
        name: name.trim(),
        vaultName: vaultName.trim() || `${name.trim()} Vault`,
      }),
    );
    if (created === undefined) return;
    setName("");
    setVaultName("");
    onCreated();
    onClose();
  };

  return (
    <Dialog open={open} onClose={onClose} title={t("teams.createTitle")}>
      <form onSubmit={submit} className="space-y-4">
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <Field label={t("teams.nameLabel")} htmlFor="team-name">
          <Input
            id="team-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={80}
            required
          />
        </Field>
        <Field label={`${t("teams.vaultNameLabel")} (${t("common.optional")})`} htmlFor="team-vault-name">
          <Input
            id="team-vault-name"
            value={vaultName}
            onChange={(event) => setVaultName(event.target.value)}
            placeholder={name ? `${name} Vault` : undefined}
            maxLength={80}
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

function TeamDetailDialog({
  team,
  onClose,
  onChanged,
}: {
  team: Team | null;
  onClose(): void;
  onChanged(): void;
}) {
  const { t, locale } = useI18n();
  const account = useAccount();
  const { run, pending, error } = useAction();
  const [inviting, setInviting] = useState(false);
  const [created, setCreated] = useState<CreatedTeamInvite | null>(null);

  const members = useAsync(
    (signal) =>
      team
        ? api.get<{ members: TeamMember[] }>(`/v1/teams/${encodeURIComponent(team.id)}/members`, { signal })
        : Promise.resolve({ members: [] }),
    [team?.id],
  );
  const invites = useAsync(
    (signal) =>
      team && (team.role === "owner" || team.role === "admin")
        ? api.get<{ invites: TeamInvite[] }>(`/v1/teams/${encodeURIComponent(team.id)}/invites`, { signal })
        : Promise.resolve({ invites: [] }),
    [team?.id, team?.role],
  );

  const canAdmin = team?.role === "owner" || team?.role === "admin";

  const removeMember = async (userId: string) => {
    if (!team) return;
    await run(() => api.delete(`/v1/teams/${encodeURIComponent(team.id)}/members/${encodeURIComponent(userId)}`));
    members.reload();
    onChanged();
  };

  const revokeInvite = async (inviteId: string) => {
    if (!team) return;
    await run(() => api.delete(`/v1/teams/${encodeURIComponent(team.id)}/invites/${encodeURIComponent(inviteId)}`));
    invites.reload();
  };

  const deleteTeam = async () => {
    if (!team) return;
    const removed = await run(() => api.delete(`/v1/teams/${encodeURIComponent(team.id)}`));
    if (removed === undefined) return;
    onChanged();
    onClose();
  };

  return (
    <>
      <Dialog
        open={Boolean(team) && !inviting && !created}
        onClose={onClose}
        title={team?.name ?? ""}
        description={team ? t(team.members === 1 ? "teams.memberCountOne" : "teams.memberCount", { count: team.members }) : undefined}
        footer={
          <>
            {team?.role === "owner" ? (
              <Button variant="danger" onClick={() => void deleteTeam()} loading={pending}>
                {t("common.delete")}
              </Button>
            ) : null}
            <Button onClick={onClose}>{t("common.close")}</Button>
          </>
        }
      >
        <div className="space-y-5">
          {error ? <Notice tone="danger">{error}</Notice> : null}

          {canAdmin ? (
            <Button
              size="sm"
              variant="primary"
              icon={<UserPlus className="h-4 w-4" />}
              onClick={() => setInviting(true)}
            >
              {t("teams.invite")}
            </Button>
          ) : null}

          <div>
            <p className="label-caps mb-2">{t("vaults.members")}</p>
            {members.loading ? (
              <LoadingBlock />
            ) : (
              <ul className="divide-y divide-line-soft">
                {(members.data?.members ?? []).map((member) => (
                  <li key={member.id} className="flex items-center justify-between gap-3 py-2.5">
                    <div className="min-w-0">
                      <p className="truncate text-[13px] font-medium text-fg">
                        {personLabel(member)}
                        {member.id === account.user.id ? (
                          <span className="ml-1.5 text-[12px] font-normal text-fg3">
                            ({t("common.you")})
                          </span>
                        ) : null}
                      </p>
                      <p className="text-[12px] text-fg3">
                        {member.vaultRole} · {formatRelative(member.joinedAt, locale)}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Badge tone={member.role === "owner" ? "accent" : "neutral"}>{member.role}</Badge>
                      {canAdmin && member.role !== "owner" ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          icon={<Trash2 className="h-3.5 w-3.5" />}
                          aria-label={t("teams.removeMember")}
                          onClick={() => void removeMember(member.id)}
                        />
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {canAdmin && (invites.data?.invites.length ?? 0) > 0 ? (
            <div>
              <p className="label-caps mb-2">{t("teams.invitePending")}</p>
              <ul className="divide-y divide-line-soft">
                {invites.data!.invites.map((invite) => (
                  <li key={invite.id} className="flex items-center justify-between gap-3 py-2.5">
                    <div className="min-w-0">
                      <p className="truncate text-[13px] text-fg2">{invite.email}</p>
                      <p className="text-[12px] text-fg3">
                        {invite.role} · {invite.vaultRole}
                      </p>
                    </div>
                    <Button size="sm" variant="ghost" onClick={() => void revokeInvite(invite.id)}>
                      {t("teams.inviteRevoke")}
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </Dialog>

      <InviteDialog
        team={team}
        open={inviting}
        onClose={() => setInviting(false)}
        onCreated={(invite) => {
          setInviting(false);
          setCreated(invite);
          invites.reload();
        }}
      />

      <Dialog
        open={Boolean(created)}
        onClose={() => setCreated(null)}
        title={t("teams.inviteTitle", { team: team?.name ?? "" })}
        footer={<Button onClick={() => setCreated(null)}>{t("common.close")}</Button>}
      >
        {created ? (
          <div className="space-y-4">
            {created.emailDelivered ? (
              <Notice tone="ok">{t("teams.inviteSent", { email: created.email })}</Notice>
            ) : (
              <Notice tone="warn">{t("teams.inviteNoMail")}</Notice>
            )}
            <CopyField value={created.inviteUrl} label={t("admin.inviteLink")} />
            <p className="text-[12.5px] text-fg3">{t("admin.inviteLinkOnce")}</p>
          </div>
        ) : null}
      </Dialog>
    </>
  );
}

function InviteDialog({
  team,
  open,
  onClose,
  onCreated,
}: {
  team: Team | null;
  open: boolean;
  onClose(): void;
  onCreated(invite: CreatedTeamInvite): void;
}) {
  const { t } = useI18n();
  const { run, pending, error } = useAction();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Exclude<TeamRole, "owner">>("member");
  const [vaultRole, setVaultRole] = useState<Exclude<VaultRole, "owner">>("editor");

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!team) return;
    const invite = await run(() =>
      api.post<CreatedTeamInvite>(`/v1/teams/${encodeURIComponent(team.id)}/invites`, {
        email: email.trim(),
        role,
        vaultRole,
      }),
    );
    if (!invite) return;
    setEmail("");
    onCreated(invite);
  };

  return (
    <Dialog open={open} onClose={onClose} title={t("teams.inviteTitle", { team: team?.name ?? "" })}>
      <form onSubmit={submit} className="space-y-4">
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <Field label={t("teams.inviteEmail")} htmlFor="invite-email">
          <Input
            id="invite-email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("teams.inviteRole")} htmlFor="invite-role">
            <Select
              id="invite-role"
              value={role}
              onChange={(event) => setRole(event.target.value as typeof role)}
            >
              <option value="member">{t("teams.roleMember")}</option>
              <option value="admin">{t("teams.roleAdmin")}</option>
            </Select>
          </Field>
          <Field label={t("teams.inviteVaultRole")} htmlFor="invite-vault-role">
            <Select
              id="invite-vault-role"
              value={vaultRole}
              onChange={(event) => setVaultRole(event.target.value as typeof vaultRole)}
            >
              <option value="viewer">{t("vaults.roleViewer")}</option>
              <option value="editor">{t("vaults.roleEditor")}</option>
              <option value="admin">{t("vaults.roleAdmin")}</option>
            </Select>
          </Field>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button type="submit" variant="primary" loading={pending}>
            {t("teams.invite")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** The page a team invitation link opens. */
export function AcceptTeamInvite() {
  const { t } = useI18n();
  const { signedIn, account } = useAuth();
  const [params] = useSearchParams();
  const { run, pending, error, done } = useAction();
  const token = params.get("token") ?? "";

  const invite = useAsync(
    (signal) =>
      token
        ? api.get<{
            teamId: string;
            teamName: string;
            email: string;
            role: TeamRole;
            vaultRole: VaultRole;
            expiresAt: string;
          }>(`/v1/team-invites/${encodeURIComponent(token)}`, { anonymous: true, signal })
        : Promise.reject(new Error("missing")),
    [token],
  );

  const accept = async () => {
    await run(() => api.post(`/v1/team-invites/${encodeURIComponent(token)}/accept`));
  };

  if (invite.loading) {
    return (
      <AuthLayout title={t("nav.teams")}>
        <LoadingBlock />
      </AuthLayout>
    );
  }
  if (invite.error || !invite.data) {
    return (
      <AuthLayout title={t("nav.teams")}>
        <Notice tone="danger">{invite.error ?? t("error.notFound")}</Notice>
      </AuthLayout>
    );
  }

  const data = invite.data;
  const wrongAccount = signedIn && account && account.user.email.toLowerCase() !== data.email.toLowerCase();

  return (
    <AuthLayout
      title={t("teams.acceptTitle", { team: data.teamName })}
      subtitle={t("teams.acceptBody", { role: data.role, vaultRole: data.vaultRole })}
    >
      {done ? (
        <div className="space-y-5">
          <Notice tone="ok">{t("teams.acceptDone", { team: data.teamName })}</Notice>
          <Link to="/teams">
            <Button variant="primary" className="w-full">
              {t("nav.teams")}
            </Button>
          </Link>
        </div>
      ) : (
        <div className="space-y-5">
          {error ? <Notice tone="danger">{error}</Notice> : null}
          {!signedIn ? (
            <>
              <Notice tone="info">{t("teams.acceptSignIn", { email: data.email })}</Notice>
              <Link to={`/signin?next=${encodeURIComponent(`/invite/team?token=${token}`)}`}>
                <Button variant="primary" className="w-full">
                  {t("auth.signIn")}
                </Button>
              </Link>
            </>
          ) : wrongAccount ? (
            <Notice tone="warn">{t("teams.acceptWrongAccount", { email: data.email })}</Notice>
          ) : (
            <Button variant="primary" className="w-full" loading={pending} onClick={() => void accept()}>
              {t("teams.acceptButton")}
            </Button>
          )}
        </div>
      )}
    </AuthLayout>
  );
}
