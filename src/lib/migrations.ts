import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { Database } from "./db";

export async function applyMigrations(database: Database): Promise<string[]> {
  await database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const folder = path.join(process.cwd(), "db", "migrations");
  const names = (await readdir(folder)).filter((name) => name.endsWith(".sql")).sort();
  const appliedNow: string[] = [];

  for (const name of names) {
    const existing = await database.query<{ name: string }>(
      "SELECT name FROM schema_migrations WHERE name = $1",
      [name]
    );
    if (existing.rowCount > 0) continue;

    const sql = await readFile(path.join(folder, name), "utf8");
    await database.transaction(async (tx) => {
      const raced = await tx.query<{ name: string }>(
        "SELECT name FROM schema_migrations WHERE name = $1",
        [name]
      );
      if (raced.rowCount > 0) return;
      await tx.exec(sql);
      await tx.query("INSERT INTO schema_migrations (name) VALUES ($1)", [name]);
    });
    appliedNow.push(name);
  }

  return appliedNow;
}

export async function seedSyntheticDemo(database: Database): Promise<void> {
  const sql = await readFile(
    path.join(process.cwd(), "db", "seeds", "0001_synthetic_travel_demo.sql"),
    "utf8"
  );
  await database.transaction((tx) => tx.exec(sql));
}
