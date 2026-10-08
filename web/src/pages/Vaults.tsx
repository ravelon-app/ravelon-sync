import { useEffect, useState } from "react";
import { Database, Pencil, Plus, Trash2, Users } from "lucide-react";

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
  Td,
  Th,
  TableWrap,
} from "../components/ui";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { formatBytes, formatNumber, formatRelative, personLabel } from "../lib/format";
import { useAction, useAsync, useDocumentTitle } from "../lib/hooks";
import { useI18n } from "../lib/i18n";
import type { Vault, VaultMember, VaultRole } from "../lib/types";

const ROLE_LABELS: Record<
  VaultRole,
  "vaults.roleOwner" | "vaults.roleAdmin" | "vaults.roleEditor" | "vaults.roleViewer"
> = {
  owner: "vaults.roleOwner",
  admin: "vaults.roleAdmin",
  editor: "vaults.roleEditor",
  viewer: "vaults.roleViewer",
};

export function Vaults() {
  const { t, locale } = useI18n();
  const { config } = useAuth();
  useDocumentTitle(t("vaults.title"), config?.serverName);

  const vaults = useAsync((signal) => api.get<{ vaults: Vault[] }>("/v1/vaults", { signal }), []);
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<Vault | null>(null);
  const [deleting, setDeleting] = useState<Vault | null>(null);
  const [renaming, setRenaming] = useState<Vault | null>(null);

  const list = vaults.data?.vaults ?? [];
  // The server lists personal vaults oldest first; the first one holds the
  // account key envelope and refuses deletion, so it offers no delete button.
  const primaryPersonalId = list.find((vault) => vault.kind === "personal" && vault.role === "owner")?.id;

  return (
    <>
      <PageHeader
        title={t("vaults.title")}
        description={t("vaults.subtitle")}
        action={
          <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>
            {t("vaults.create")}
          </Button>
        }
      />

      {vaults.error ? <Notice tone="danger">{vaults.error}</Notice> : null}

      <Panel>
        {vaults.loading ? (
          <LoadingBlock />
        ) : list.length === 0 ? (
          <EmptyState icon={<Database className="h-7 w-7" />} title={t("vaults.empty")} />
        ) : (
          <TableWrap>
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-line-soft">
                  <Th>{t("common.name")}</Th>
                  <Th>{t("common.role")}</Th>
                  <Th className="text-right">{t("admin.vaultRecords")}</Th>
                  <Th className="hidden text-right xl:table-cell">{t("admin.vaultStorage")}</Th>
                  <Th className="hidden xl:table-cell">{t("vaults.lastActivity")}</Th>
                  <Th className="text-right">{t("common.actions")}</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line-soft">
                {list.map((vault) => (
                  <tr key={vault.id} className="transition-colors hover:bg-raised/40">
                    <Td>
                      <div className="flex items-center gap-2.5">
                        <span className="min-w-0">
                          <span className="block truncate font-medium text-fg">{vault.name}</span>
                          {/* The full id wrapped over four lines in a narrow table; the
                              first block is enough to tell vaults apart. */}
                          <span className="mt-0.5 block font-mono text-[11px] text-fg3" title={vault.id}>
                            {vault.id.slice(0, 8)}
                          </span>
                          {vault.id === primaryPersonalId ? (
                            <span className="mt-0.5 block text-xs text-fg3">{t("vaults.primaryHint")}</span>
                          ) : null}
                        </span>
                        <Badge tone={vault.kind === "team" ? "accent" : "neutral"}>
                          {vault.kind === "team" ? t("vaults.team") : t("vaults.personal")}
                        </Badge>
                      </div>
                    </Td>
                    <Td>{t(ROLE_LABELS[vault.role])}</Td>
                    <Td className="text-right font-mono tabular-nums">
                      {formatNumber(vault.itemCount ?? 0, locale)}
                    </Td>
                    <Td className="hidden text-right font-mono tabular-nums xl:table-cell">
                      {formatBytes(vault.storageBytes ?? 0)}
                    </Td>
                    <Td className="hidden whitespace-nowrap xl:table-cell">
                      {formatRelative(vault.updatedAt, locale)}
                    </Td>
                    <Td className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          icon={<Users className="h-3.5 w-3.5" />}
                          onClick={() => setSelected(vault)}
                        >
                          {t("vaults.members")}
                        </Button>
                        {vault.role === "owner" || vault.role === "admin" ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            icon={<Pencil className="h-3.5 w-3.5" />}
                            onClick={() => setRenaming(vault)}
                            aria-label={t("common.rename")}
                            title={t("common.rename")}
                          />
                        ) : null}
                        {vault.role === "owner" && vault.id !== primaryPersonalId ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            icon={<Trash2 className="h-3.5 w-3.5" />}
                            onClick={() => setDeleting(vault)}
                            aria-label={t("common.delete")}
                          />
                        ) : null}
                      </div>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Panel>

      <CreateVaultDialog open={creating} onClose={() => setCreating(false)} onCreated={vaults.reload} />
      <VaultMembersDialog vault={selected} onClose={() => setSelected(null)} />
      <DeleteVaultDialog vault={deleting} onClose={() => setDeleting(null)} onDeleted={vaults.reload} />
      <RenameVaultDialog vault={renaming} onClose={() => setRenaming(null)} onRenamed={vaults.reload} />
    </>
  );
}

function CreateVaultDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose(): void;
  onCreated(): void;
}) {
  const { t } = useI18n();
  const { run, pending, error, reset } = useAction();
  const [name, setName] = useState("");

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const created = await run(() => api.post("/v1/vaults", { name: name.trim(), kind: "personal" }));
    if (created === undefined) return;
    setName("");
    reset();
    onCreated();
    onClose();
  };

  return (
    <Dialog open={open} onClose={onClose} title={t("vaults.createTitle")}>
      <form id="create-vault" onSubmit={submit} className="space-y-4">
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <Field label={t("vaults.nameLabel")} htmlFor="vault-name">
          <Input
            id="vault-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={80}
            required
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

function VaultMembersDialog({ vault, onClose }: { vault: Vault | null; onClose(): void }) {
  const { t, locale } = useI18n();
  const members = useAsync(
    (signal) =>
      vault
        ? api.get<{ members: VaultMember[] }>(`/v1/vaults/${encodeURIComponent(vault.id)}/members`, {
            signal,
          })
        : Promise.resolve({ members: [] }),
    [vault?.id],
  );

  return (
    <Dialog
      open={Boolean(vault)}
      onClose={onClose}
      title={vault?.name ?? ""}
      description={vault?.kind === "team" ? t("vaults.addMemberHint") : undefined}
      footer={<Button onClick={onClose}>{t("common.close")}</Button>}
    >
      {members.loading ? (
        <LoadingBlock />
      ) : (
        <ul className="divide-y divide-line-soft">
          {(members.data?.members ?? []).map((member) => (
            <li key={member.id} className="flex items-center justify-between gap-4 py-2.5">
              <div className="min-w-0">
                <p className="truncate text-[13px] font-medium text-fg">{personLabel(member)}</p>
                <p className="text-[12px] text-fg3">{formatRelative(member.joinedAt, locale)}</p>
              </div>
              <Badge tone={member.role === "owner" ? "accent" : "neutral"}>
                {t(ROLE_LABELS[member.role])}
              </Badge>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}

function DeleteVaultDialog({
  vault,
  onClose,
  onDeleted,
}: {
  vault: Vault | null;
  onClose(): void;
  onDeleted(): void;
}) {
  const { t } = useI18n();
  const { run, pending, error } = useAction();
  const [confirmation, setConfirmation] = useState("");

  const submit = async () => {
    if (!vault) return;
    const removed = await run(() => api.delete(`/v1/vaults/${encodeURIComponent(vault.id)}`));
    if (removed === undefined) return;
    setConfirmation("");
    onDeleted();
    onClose();
  };

  return (
    <Dialog
      open={Boolean(vault)}
      onClose={onClose}
      tone="danger"
      title={t("vaults.deleteTitle", { name: vault?.name ?? "" })}
      description={t("vaults.deleteBody")}
      footer={
        <>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button
            variant="danger"
            loading={pending}
            // Typing the name is the difference between a considered deletion
            // and one stray click on the row you happened to be hovering.
            disabled={confirmation.trim() !== vault?.name}
            onClick={() => void submit()}
          >
            {t("common.delete")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <Field label={t("vaults.deleteConfirm")} htmlFor="vault-confirm">
          <Input
            id="vault-confirm"
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            placeholder={vault?.name}
            autoComplete="off"
          />
        </Field>
      </div>
    </Dialog>
  );
}

function RenameVaultDialog({
  vault,
  onClose,
  onRenamed,
}: {
  vault: Vault | null;
  onClose(): void;
  onRenamed(): void;
}) {
  const { t } = useI18n();
  const { run, pending, error } = useAction();
  const [name, setName] = useState("");

  useEffect(() => {
    setName(vault?.name ?? "");
  }, [vault]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!vault || !name.trim()) return;
    const renamed = await run(() =>
      api.patch(`/v1/vaults/${encodeURIComponent(vault.id)}`, { name: name.trim() }),
    );
    if (renamed === undefined) return;
    onRenamed();
    onClose();
  };

  return (
    <Dialog open={Boolean(vault)} onClose={onClose} title={t("vaults.renameTitle")}>
      <form onSubmit={submit} className="space-y-4">
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <Field label={t("vaults.nameLabel")} htmlFor="vault-rename">
          <Input
            id="vault-rename"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={80}
            autoFocus
            required
          />
        </Field>
        <div className="flex justify-end gap-2 pt-2">
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button
            type="submit"
            variant="primary"
            loading={pending}
            disabled={!name.trim() || name.trim() === vault?.name}
          >
            {t("common.rename")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
