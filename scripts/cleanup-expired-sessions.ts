import { closeDatabase, getDatabase } from "../src/lib/db";
import { cleanupExpiredReviewSessions, MAX_EXPIRED_SESSION_CLEANUP_BATCH } from "../src/lib/session-cleanup";

async function main() {
  const rawBatch = process.env.TRACEPILOT_CLEANUP_BATCH ?? "25";
  const batchSize = Number(rawBatch);
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_EXPIRED_SESSION_CLEANUP_BATCH) {
    throw new Error(`TRACEPILOT_CLEANUP_BATCH must be an integer from 1 to ${MAX_EXPIRED_SESSION_CLEANUP_BATCH}.`);
  }

  const database = await getDatabase();
  const purged = await cleanupExpiredReviewSessions(batchSize, database);
  console.log(`Removed ${purged} expired synthetic review workspace${purged === 1 ? "" : "s"}.`);
}

main().finally(closeDatabase).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Expired session cleanup failed.");
  process.exitCode = 1;
});
