import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite, type PgliteDatabase } from "drizzle-orm/pglite";
import { drizzle as drizzlePostgres, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema.js";

export type ProxyPgliteDatabase = PgliteDatabase<typeof schema>;
export type ProxyPostgresDatabase = PostgresJsDatabase<typeof schema>;
export type ProxyDatabase = ProxyPgliteDatabase | ProxyPostgresDatabase;
export type ProxyPgliteTransaction = Parameters<Parameters<ProxyPgliteDatabase["transaction"]>[0]>[0];
export type ProxyPostgresTransaction = Parameters<Parameters<ProxyPostgresDatabase["transaction"]>[0]>[0];
export type ProxyTransaction = ProxyPgliteTransaction | ProxyPostgresTransaction;
export type ProxyDbSession = ProxyDatabase | ProxyTransaction;
export type ProxyTransactionalDatabase = {
  transaction<T>(callback: (tx: ProxyTransaction) => Promise<T>): Promise<T>;
};

export type PostgresDatabaseOptions = {
  max?: number;
};

export function createPostgresDatabase(databaseUrl: string, options: PostgresDatabaseOptions = {}): ProxyPostgresDatabase {
  return drizzlePostgres(postgres(databaseUrl, { max: options.max ?? 5 }), { schema });
}

export function createPgliteDatabase(client = new PGlite()): ProxyPgliteDatabase {
  return drizzlePglite(client, { schema });
}

export function createTransactionalDatabase(db: ProxyDatabase): ProxyTransactionalDatabase {
  return {
    transaction<T>(callback: (tx: ProxyTransaction) => Promise<T>) {
      return db.transaction((tx) => callback(tx as ProxyTransaction));
    }
  };
}
