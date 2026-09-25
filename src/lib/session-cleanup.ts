import { getDatabase, type Database, type Queryable } from "@/lib/db";

export const MAX_EXPIRED_SESSION_CLEANUP_BATCH = 100;

export async function cleanupExpiredReviewSessionsInTransaction(
  tx: Queryable,
  batchSize = 25
): Promise<number> {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_EXPIRED_SESSION_CLEANUP_BATCH) {
    throw new RangeError(`Expired session cleanup batch must be an integer from 1 to ${MAX_EXPIRED_SESSION_CLEANUP_BATCH}.`);
  }

  await tx.query("SELECT lock_id FROM review_session_capacity_lock WHERE lock_id = 1 FOR UPDATE");
  const expired = await tx.query<{ workspace_id: string }>(
    `SELECT workspace_id FROM review_sessions
     WHERE expires_at <= now()
     ORDER BY expires_at ASC
     LIMIT $1`,
    [batchSize]
  );
  const workspaceIds = expired.rows.map((row) => row.workspace_id);
  if (!workspaceIds.length) return 0;

  await tx.query("SELECT set_config('tracepilot.allow_expired_cleanup', 'on', true)");
  await tx.query("DELETE FROM decisions WHERE workspace_id = ANY($1::uuid[])", [workspaceIds]);
  await tx.query("DELETE FROM rerun_executions WHERE workspace_id = ANY($1::uuid[])", [workspaceIds]);
  await tx.query("DELETE FROM proposals WHERE workspace_id = ANY($1::uuid[])", [workspaceIds]);
  await tx.query(
    `DELETE FROM check_results
     WHERE run_id IN (SELECT id FROM runs WHERE workspace_id = ANY($1::uuid[]))`,
    [workspaceIds]
  );
  await tx.query(
    `DELETE FROM run_spans
     WHERE run_id IN (SELECT id FROM runs WHERE workspace_id = ANY($1::uuid[]))`,
    [workspaceIds]
  );
  await tx.query(
    `DELETE FROM run_events
     WHERE run_id IN (SELECT id FROM runs WHERE workspace_id = ANY($1::uuid[]))`,
    [workspaceIds]
  );
  await tx.query(
    `DELETE FROM constraints
     WHERE run_id IN (SELECT id FROM runs WHERE workspace_id = ANY($1::uuid[]))`,
    [workspaceIds]
  );
  await tx.query("DELETE FROM runs WHERE workspace_id = ANY($1::uuid[])", [workspaceIds]);
  await tx.query("DELETE FROM review_sessions WHERE workspace_id = ANY($1::uuid[])", [workspaceIds]);
  await tx.query("DELETE FROM workspaces WHERE id = ANY($1::uuid[])", [workspaceIds]);
  return workspaceIds.length;
}

export async function cleanupExpiredReviewSessions(
  batchSize = 25,
  databaseOverride?: Database
): Promise<number> {
  const database = databaseOverride ?? await getDatabase();
  return database.transaction((tx) => cleanupExpiredReviewSessionsInTransaction(tx, batchSize));
}
