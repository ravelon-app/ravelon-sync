import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import {
  api,
  register,
  startTestServer,
  syncItem,
  type TestAccount,
  type TestServer,
} from './helpers.js';

describe('teams and shared vaults', () => {
  let server: TestServer;
  let owner: TestAccount;
  let member: TestAccount;
  let outsider: TestAccount;
  let teamId: string;
  let teamVaultId: string;

  before(async () => {
    server = await startTestServer();
    owner = await register(server, 'owner@example.com');
    await api(server, 'PUT', '/v1/admin/settings/platform', {
      token: owner.accessToken,
      body: { serverName: 'Test Server', registrationMode: 'open' },
    });
    member = await register(server, 'member@example.com');
    outsider = await register(server, 'outsider@example.com');
  });

  after(async () => {
    await server.close();
  });

  test('creating a team also creates its vault', async () => {
    const response = await api(server, 'POST', '/v1/teams', {
      token: owner.accessToken,
      body: { name: 'Platform', vaultName: 'Platform Vault' },
    });
    assert.equal(response.status, 201);
    assert.equal(response.body.name, 'Platform');
    assert.equal(response.body.role, 'owner');
    assert.equal(response.body.vaults.length, 1);
    assert.equal(response.body.vaults[0].kind, 'team');
    teamId = response.body.id;
    teamVaultId = response.body.vaults[0].id;
  });

  test('an invitation only works for the address it names', async () => {
    const invite = await api(server, 'POST', `/v1/teams/${teamId}/invites`, {
      token: owner.accessToken,
      body: { email: 'member@example.com', role: 'member', vaultRole: 'editor' },
    });
    assert.equal(invite.status, 201);
    const token = invite.body.token;

    const wrongPerson = await api(server, 'POST', `/v1/team-invites/${token}/accept`, {
      token: outsider.accessToken,
    });
    assert.equal(wrongPerson.status, 403);
    assert.equal(wrongPerson.body.error.code, 'invite_email_mismatch');

    const accepted = await api(server, 'POST', `/v1/team-invites/${token}/accept`, {
      token: member.accessToken,
    });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.id, teamId);

    // A second acceptance must not work, or a forwarded link stays live. A
    // spent token is answered exactly like an unknown one, so holding an old
    // link tells you nothing about whether it ever existed.
    const reuse = await api(server, 'POST', `/v1/team-invites/${token}/accept`, {
      token: member.accessToken,
    });
    assert.equal(reuse.status, 404);
    assert.equal(reuse.body.error.code, 'invite_invalid');
  });

  test('accepting grants access to the team vault', async () => {
    const vaults = await api(server, 'GET', '/v1/vaults', { token: member.accessToken });
    const teamVault = vaults.body.vaults.find((vault: any) => vault.id === teamVaultId);
    assert.ok(teamVault, 'the team vault should now be listed for the member');
    assert.equal(teamVault.role, 'editor');

    const push = await api(server, 'POST', '/v1/sync/push', {
      token: member.accessToken,
      body: { vaultId: teamVaultId, items: [syncItem('team-host', teamVaultId)] },
    });
    assert.equal(push.status, 200);
    assert.equal(push.body.results[0].status, 'stored');
  });

  test('an outsider sees nothing of the team vault', async () => {
    const pull = await api(server, 'GET', `/v1/sync/pull?vaultId=${teamVaultId}&cursor=0`, {
      token: outsider.accessToken,
    });
    assert.equal(pull.status, 403);
    const members = await api(server, 'GET', `/v1/teams/${teamId}/members`, {
      token: outsider.accessToken,
    });
    assert.equal(members.status, 403);
  });

  test('a viewer can read but not write', async () => {
    const changed = await api(server, 'PATCH', `/v1/teams/${teamId}/members/${member.userId}`, {
      token: owner.accessToken,
      body: { vaultRole: 'viewer' },
    });
    assert.equal(changed.status, 200);

    const pull = await api(server, 'GET', `/v1/sync/pull?vaultId=${teamVaultId}&cursor=0`, {
      token: member.accessToken,
    });
    assert.equal(pull.status, 200);
    assert.ok(pull.body.items.length > 0);

    const push = await api(server, 'POST', '/v1/sync/push', {
      token: member.accessToken,
      body: { vaultId: teamVaultId, items: [syncItem('nope', teamVaultId)] },
    });
    assert.equal(push.status, 403);
    assert.equal(push.body.error.code, 'vault_write_required');
  });

  test('each member keeps separate wrapped key material, including viewers', async () => {
    const ownerMaterial = { version: 1, ciphertext: 'owner-envelope', nonce: 'owner-nonce' };
    const memberMaterial = { version: 1, ciphertext: 'member-envelope', nonce: 'member-nonce' };

    const ownerStored = await api(server, 'PUT', '/v1/vault/key-material', {
      token: owner.accessToken,
      body: { vaultId: teamVaultId, material: ownerMaterial },
    });
    assert.equal(ownerStored.status, 200);

    const viewerStored = await api(server, 'PUT', '/v1/vault/key-material', {
      token: member.accessToken,
      body: { vaultId: teamVaultId, material: memberMaterial },
    });
    assert.equal(viewerStored.status, 200);

    const ownerRead = await api(server, 'GET', `/v1/vault/key-material?vaultId=${teamVaultId}`, {
      token: owner.accessToken,
    });
    const memberRead = await api(server, 'GET', `/v1/vault/key-material?vaultId=${teamVaultId}`, {
      token: member.accessToken,
    });
    assert.deepEqual(ownerRead.body.material, ownerMaterial);
    assert.deepEqual(memberRead.body.material, memberMaterial);
  });

  test('a member cannot promote themselves', async () => {
    const response = await api(server, 'PATCH', `/v1/teams/${teamId}/members/${member.userId}`, {
      token: member.accessToken,
      body: { role: 'admin' },
    });
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'team_admin_required');
  });

  test('removing a member also removes their vault access', async () => {
    const removed = await api(server, 'DELETE', `/v1/teams/${teamId}/members/${member.userId}`, {
      token: owner.accessToken,
    });
    assert.equal(removed.status, 204);

    // Access must go with the membership. Otherwise a removed colleague keeps
    // pulling records they can still decrypt on their own device.
    const pull = await api(server, 'GET', `/v1/sync/pull?vaultId=${teamVaultId}&cursor=0`, {
      token: member.accessToken,
    });
    assert.equal(pull.status, 403);
  });

  test('the owner cannot be removed while they still own the team', async () => {
    const response = await api(server, 'DELETE', `/v1/teams/${teamId}/members/${owner.userId}`, {
      token: owner.accessToken,
    });
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, 'team_owner_locked');
  });

  test('ownership transfers, and the previous owner stays an administrator', async () => {
    const invite = await api(server, 'POST', `/v1/teams/${teamId}/invites`, {
      token: owner.accessToken,
      body: { email: 'member@example.com', role: 'admin', vaultRole: 'admin' },
    });
    await api(server, 'POST', `/v1/team-invites/${invite.body.token}/accept`, {
      token: member.accessToken,
    });

    const transferred = await api(server, 'POST', `/v1/teams/${teamId}/transfer-ownership`, {
      token: owner.accessToken,
      body: { userId: member.userId },
    });
    assert.equal(transferred.status, 200);
    assert.equal(transferred.body.ownerUserId, member.userId);

    const members = await api(server, 'GET', `/v1/teams/${teamId}/members`, {
      token: member.accessToken,
    });
    const previous = members.body.members.find((entry: any) => entry.id === owner.userId);
    assert.equal(previous.role, 'admin');
  });

  test('only the owner can delete a team, and its vault goes with it', async () => {
    const wrongPerson = await api(server, 'DELETE', `/v1/teams/${teamId}`, {
      token: owner.accessToken,
    });
    assert.equal(wrongPerson.status, 403);
    assert.equal(wrongPerson.body.error.code, 'team_owner_required');

    const deleted = await api(server, 'DELETE', `/v1/teams/${teamId}`, {
      token: member.accessToken,
    });
    assert.equal(deleted.status, 204);

    const vaults = await api(server, 'GET', '/v1/vaults', { token: member.accessToken });
    assert.ok(!vaults.body.vaults.some((vault: any) => vault.id === teamVaultId));
  });
});

describe('personal vaults', () => {
  let server: TestServer;
  let user: TestAccount;

  before(async () => {
    server = await startTestServer();
    user = await register(server, 'vaults@example.com');
  });

  after(async () => {
    await server.close();
  });

  test('a named vault can be created and renamed', async () => {
    const created = await api(server, 'POST', '/v1/vaults', {
      token: user.accessToken,
      body: { name: 'Work', kind: 'personal' },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.name, 'Work');
    assert.equal(created.body.role, 'owner');

    const renamed = await api(server, 'PATCH', `/v1/vaults/${created.body.id}`, {
      token: user.accessToken,
      body: { name: 'Work Servers' },
    });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.name, 'Work Servers');
  });

  test('an older version of a record can be restored forward', async () => {
    const vaultId = 'history-vault';
    await api(server, 'POST', '/v1/sync/push', {
      token: user.accessToken,
      body: { vaultId, items: [syncItem('host-a', vaultId, { clientRevision: 1 })] },
    });
    await api(server, 'POST', '/v1/sync/push', {
      token: user.accessToken,
      body: {
        vaultId,
        items: [syncItem('host-a', vaultId, { clientRevision: 2, ciphertext: 'b64:c2Vjb25kLXZlcnNpb24tYnl0ZXM' })],
      },
    });

    const versions = await api(server, 'GET', `/v1/vaults/${vaultId}/items/host-a/versions`, {
      token: user.accessToken,
    });
    assert.equal(versions.status, 200);
    assert.equal(versions.body.versions.length, 2);
    // Metadata only. Restoring is how a version comes back, not reading it here.
    assert.equal(versions.body.versions[0].ciphertext, undefined);

    const oldest = versions.body.versions[versions.body.versions.length - 1];
    const restored = await api(server, 'POST', `/v1/vaults/${vaultId}/items/host-a/restore`, {
      token: user.accessToken,
      body: { versionId: oldest.id },
    });
    assert.equal(restored.status, 200);

    // Restoring must move the cursor forward, so every other device pulls the
    // restored state instead of quietly disagreeing about history.
    const pulled = await api(server, 'GET', `/v1/sync/pull?vaultId=${vaultId}&cursor=0`, {
      token: user.accessToken,
    });
    const item = pulled.body.items.find((entry: any) => entry.id === 'host-a');
    assert.ok(Number(item.revision) > Number(oldest.revision));
    assert.ok(item.restoredAt);
  });

  test('deleting a vault takes its encrypted records with it', async () => {
    const created = await api(server, 'POST', '/v1/vaults', {
      token: user.accessToken,
      body: { name: 'Temporary' },
    });
    const vaultId = created.body.id;
    await api(server, 'POST', '/v1/sync/push', {
      token: user.accessToken,
      body: { vaultId, items: [syncItem('doomed', vaultId)] },
    });

    const deleted = await api(server, 'DELETE', `/v1/vaults/${vaultId}`, { token: user.accessToken });
    assert.equal(deleted.status, 204);

    const items = await server.db.prepare('SELECT COUNT(*) AS count FROM sync_items WHERE vault_id = ?')
      .get<{ count: number }>(vaultId);
    assert.equal(Number(items?.count ?? 0), 0);
  });
});

describe('signing up from a team invitation', () => {
  let server: TestServer;
  let owner: TestAccount;
  let teamId: string;
  let teamVaultId: string;

  before(async () => {
    // The first account; registration stays at the invite-only default.
    server = await startTestServer();
    owner = await register(server, 'lead@example.com');
    const team = await api(server, 'POST', '/v1/teams', {
      token: owner.accessToken,
      body: { name: 'Ops', vaultName: 'Ops Vault' },
    });
    teamId = team.body.id;
    teamVaultId = team.body.vaults[0].id;
  });

  after(async () => {
    await server.close();
  });

  async function teamInvite(email: string): Promise<string> {
    const invite = await api(server, 'POST', `/v1/teams/${teamId}/invites`, {
      token: owner.accessToken,
      body: { email, role: 'member', vaultRole: 'editor' },
    });
    assert.equal(invite.status, 201);
    return invite.body.token;
  }

  function signUp(email: string, body: Record<string, unknown>) {
    return api(server, 'POST', '/v1/auth/register', {
      body: { email, password: 'correct-horse-battery-staple', deviceName: 'Web', platform: 'test', ...body },
    });
  }

  test('without any invitation an invite-only server still refuses', async () => {
    const refused = await signUp('walkin@example.com', {});
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error.code, 'invite_required');
  });

  test('a team invitation admits the invited address and joins the team', async () => {
    const token = await teamInvite('newcomer@example.com');
    const created = await signUp('newcomer@example.com', { teamInviteToken: token });
    assert.equal(created.status, 201);
    assert.equal(created.body.teamId, teamId);

    const vaults = await api(server, 'GET', '/v1/vaults', { token: created.body.accessToken });
    const teamVault = vaults.body.vaults.find((vault: any) => vault.id === teamVaultId);
    assert.equal(teamVault?.role, 'editor', 'the new account reaches the team vault');

    const reuse = await signUp('newcomer2@example.com', { teamInviteToken: token });
    assert.equal(reuse.status, 404, 'a spent team invitation opens no second account');
  });

  test('a forwarded team invitation does not open an account for someone else', async () => {
    const token = await teamInvite('intended@example.com');
    const forwarded = await signUp('someone-else@example.com', { teamInviteToken: token });
    assert.equal(forwarded.status, 403);
    assert.equal(forwarded.body.error.code, 'invite_email_mismatch');

    // The rightful person can still use it afterwards.
    const rightful = await signUp('intended@example.com', { teamInviteToken: token });
    assert.equal(rightful.status, 201);
  });

  test('a revoked team invitation admits nobody', async () => {
    const token = await teamInvite('revoked@example.com');
    const invites = await api(server, 'GET', `/v1/teams/${teamId}/invites`, { token: owner.accessToken });
    const pending = invites.body.invites.find((invite: any) => invite.email === 'revoked@example.com');
    const revoked = await api(server, 'DELETE', `/v1/teams/${teamId}/invites/${pending.id}`, { token: owner.accessToken });
    assert.ok(revoked.status === 200 || revoked.status === 204, `revoke answered ${revoked.status}`);
    const refused = await signUp('revoked@example.com', { teamInviteToken: token });
    assert.equal(refused.status, 404);
  });
});
