import { mkdirSync } from "node:fs";
import path from "node:path";
import { Pool, type PoolClient } from "pg";
import { PGlite } from "@electric-sql/pglite";

export type DbRow = Record<string, unknown>;

export interface QueryResult<T extends DbRow = DbRow> {
  rows: T[];
  rowCount: number;
}

export interface Queryable {
  query<T extends DbRow = DbRow>(sql: string, params?: readonly unknown[]): Promise<QueryResult<T>>;
  exec(sql: string): Promise<void>;
}

export interface Database extends Queryable {
  transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

type PGliteLike = {
  query<T extends DbRow>(sql: string, params?: unknown[]): Promise<{
    rows: T[];
    affectedRows?: number;
  }>;
  exec(sql: string): Promise<unknown>;
  transaction<T>(work: (tx: PGliteLike) => Promise<T>): Promise<T>;
  close(): Promise<unknown>;
};

function createPGliteDatabase(engine: PGliteLike): Database {
  const queryable = pgliteQueryable(engine);
  return {
    query: queryable.query,
    exec: queryable.exec,
    async transaction<T>(work: (tx: Queryable) => Promise<T>) {
      return engine.transaction(async (tx) => work(pgliteQueryable(tx)));
    },
    async close() {
      await engine.close();
    },
  };
}

function pgliteQueryable(engine: PGliteLike): Queryable {
  return {
    async query<T extends DbRow>(sql: string, params: readonly unknown[] = []) {
      const result = await engine.query<T>(sql, [...params]);
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
    },
    async exec(sql: string) {
      await engine.exec(sql);
    }
  };
}

function createPostgresDatabase(pool: Pool): Database {
  const run = async <T extends DbRow>(client: Pool | PoolClient, sql: string, params: readonly unknown[] = []) => {
    const result = await client.query<T>(sql, [...params]);
    return { rows: result.rows, rowCount: result.rowCount ?? result.rows.length };
  };

  return {
    query: <T extends DbRow>(sql: string, params: readonly unknown[] = []) => run<T>(pool, sql, params),
    async exec(sql: string) {
      await pool.query(sql);
    },
    async transaction<T>(work: (tx: Queryable) => Promise<T>) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await work({
          query: <R extends DbRow>(sql: string, params: readonly unknown[] = []) => run<R>(client, sql, params),
          async exec(sql: string) {
            await client.query(sql);
          }
        });
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    }
  };
}

let databasePromise: Promise<Database> | undefined;
let testDatabase: Database | undefined;

export function setDatabaseForTests(database: Database | undefined): void {
  testDatabase = database;
}

export async function getDatabase(): Promise<Database> {
  if (testDatabase) return testDatabase;
  if (!process.env.DATABASE_URL && process.env.NODE_ENV === "production") {
    throw new Error("DATABASE_URL is required in production. The local PGlite fallback is disabled.");
  }
  if (!databasePromise) {
    databasePromise = (async () => {
      if (process.env.DATABASE_URL) {
        return createPostgresDatabase(new Pool({ connectionString: process.env.DATABASE_URL, max: 5 }));
      }

      if (process.env.TRACEPILOT_LOCAL_DB !== "true") {
        throw new Error("DATABASE_URL is required. Set TRACEPILOT_LOCAL_DB=true only for an explicit local demo database.");
      }

      const dataPath = path.join(process.cwd(), "data", "local-pglite");
      mkdirSync(path.dirname(dataPath), { recursive: true });
      const engine = new PGlite(dataPath) as unknown as PGliteLike;
      return createPGliteDatabase(engine);
    })();
  }
  return databasePromise;
}

export function createPGliteTestDatabase(engine: PGlite): Database {
  return createPGliteDatabase(engine as unknown as PGliteLike);
}

export async function closeDatabase(): Promise<void> {
  const current = databasePromise;
  databasePromise = undefined;
  if (current) await (await current).close();
}
