import { loadEnvConfig } from "@next/env";
import { closeDatabase, getDatabase } from "../src/lib/db";
import { applyMigrations } from "../src/lib/migrations";

loadEnvConfig(process.cwd());

async function main() {
  try {
    const applied = await applyMigrations(await getDatabase());
    console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Database is already up to date.");
  } finally {
    await closeDatabase();
  }
}

void main().catch((error: unknown) => {
  console.error("Database migration failed.", error instanceof Error ? error.message : "Unknown error");
  process.exitCode = 1;
});
