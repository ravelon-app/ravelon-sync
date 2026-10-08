import { nowIso } from '../config.js';
import type { AppDatabase } from '../db/database.js';
import { ApiError } from './errors.js';

/**
 * Refuses to delete an account that still owns a team.
 *
 * `teams.owner_user_id` cascades on delete, so removing the owner would take
 * the team, its vaults and every member's encrypted records with it. Ownership
 * has to move to someone else first.
 */
export async function assertOwnsNoTeams(db: AppDatabase, userId: string): Promise<void> {
  const owned = await db
    .prepare('SELECT COUNT(*) AS count FROM teams WHERE owner_user_id = ?')
    .get<{ count: number | string }>(userId);
  if (Number(owned?.count ?? 0) > 0) {
    throw new ApiError(
      409,
      'owns_teams',
      'Transfer ownership of every team this account owns before deleting it',
    );
  }
}

/**
 * Deletes an account without taking shared team data with it.
 *
 * A team vault records the account that created it in `vaults.user_id`, which
 * cascades on delete. A team administrator who created a vault and then left
 * would otherwise delete that vault for the whole team, so those vaults are
 * handed to the team's owner in the same transaction.
 */
export async function deleteAccount(db: AppDatabase, userId: string): Promise<void> {
  await db.transaction(async () => {
    await assertOwnsNoTeams(db, userId);
    await db
      .prepare(
        `UPDATE vaults
       SET user_id = (SELECT t.owner_user_id FROM teams t WHERE t.id = vaults.team_id), updated_at = ?
       WHERE user_id = ? AND team_id IS NOT NULL`,
      )
      .run(nowIso(), userId);
    await db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  })();
}
