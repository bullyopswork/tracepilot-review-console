import { loadEnvConfig } from "@next/env";
import { closeDatabase, getDatabase } from "../src/lib/db";
import { applyMigrations, seedSyntheticDemo } from "../src/lib/migrations";

loadEnvConfig(process.cwd());

async function main() {
  try {
    const database = await getDatabase();
    await applyMigrations(database);
    await seedSyntheticDemo(database);
    console.log("Synthetic Kyoto demo fixtures are seeded.");
  } finally {
    await closeDatabase();
  }
}

void main().catch((error: unknown) => {
  console.error("Database seed failed.", error instanceof Error ? error.message : "Unknown error");
  process.exitCode = 1;
});
