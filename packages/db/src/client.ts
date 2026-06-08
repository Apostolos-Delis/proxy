import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite, type PgliteDatabase } from "drizzle-orm/pglite";
import { drizzle as drizzlePostgres, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema.js";

export type PromptProxyPgliteDatabase = PgliteDatabase<typeof schema>;
export type PromptProxyPostgresDatabase = PostgresJsDatabase<typeof schema>;
export type PromptProxyDatabase = PromptProxyPgliteDatabase | PromptProxyPostgresDatabase;
export type PromptProxyPgliteTransaction = Parameters<Parameters<PromptProxyPgliteDatabase["transaction"]>[0]>[0];
export type PromptProxyPostgresTransaction = Parameters<Parameters<PromptProxyPostgresDatabase["transaction"]>[0]>[0];
export type PromptProxyTransaction = PromptProxyPgliteTransaction | PromptProxyPostgresTransaction;
export type PromptProxyDbSession = PromptProxyDatabase | PromptProxyTransaction;
export type PromptProxyTransactionalDatabase = {
  transaction<T>(callback: (tx: PromptProxyTransaction) => Promise<T>): Promise<T>;
};

export function createPostgresDatabase(databaseUrl: string): PromptProxyPostgresDatabase {
  return drizzlePostgres(postgres(databaseUrl), { schema });
}

export function createPgliteDatabase(client = new PGlite()): PromptProxyPgliteDatabase {
  return drizzlePglite(client, { schema });
}

export function createTransactionalDatabase(db: PromptProxyDatabase): PromptProxyTransactionalDatabase {
  return {
    transaction<T>(callback: (tx: PromptProxyTransaction) => Promise<T>) {
      return db.transaction((tx) => callback(tx as PromptProxyTransaction));
    }
  };
}
