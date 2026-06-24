import { inspect } from "node:util";

import {
  and,
  asc,
  between,
  count,
  desc,
  eq,
  getTableName,
  gt,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  like,
  lt,
  lte,
  ne,
  not,
  or,
  sql as drizzleSql
} from "drizzle-orm";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import type { PgTable } from "drizzle-orm/pg-core";
import postgres, { type Sql } from "postgres";

import * as schema from "./schema.js";

const DEFAULT_DATABASE_URL = "postgres://proxy:proxy@localhost:5432/proxy";

const operators = {
  and,
  asc,
  between,
  count,
  desc,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  like,
  lt,
  lte,
  ne,
  not,
  or,
  sql: drizzleSql
};

type TableInfo = {
  exportName: string;
  tableName: string;
  table: PgTable;
};

type ConsoleBindings = Record<string, unknown>;

function tableNameFor(value: unknown): string | null {
  try {
    return getTableName(value as Parameters<typeof getTableName>[0]);
  } catch {
    return null;
  }
}

function loadTables(): TableInfo[] {
  const tables: TableInfo[] = [];
  for (const [exportName, value] of Object.entries(schema)) {
    const tableName = tableNameFor(value);
    if (tableName) {
      tables.push({ exportName, tableName, table: value as PgTable });
    }
  }
  return tables.sort((left, right) => left.exportName.localeCompare(right.exportName));
}

function resolveTable(input: string | PgTable, tables: TableInfo[]): TableInfo {
  if (typeof input !== "string") {
    const tableName = tableNameFor(input);
    const match = tables.find((table) => table.table === input || table.tableName === tableName);
    if (match) return match;
    throw new Error("Unknown table object.");
  }

  const normalized = input.trim();
  const match = tables.find((table) => (
    table.exportName === normalized ||
    table.tableName === normalized ||
    table.tableName.replaceAll("_", "").toLowerCase() === normalized.toLowerCase()
  ));
  if (!match) {
    throw new Error(`Unknown table "${input}". Run showTables() for available tables.`);
  }
  return match;
}

function printValue(value: unknown): unknown {
  console.log(inspect(value, { colors: true, depth: 8, maxArrayLength: 100 }));
  return value;
}

export function databaseUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return env.DATABASE_URL?.trim() || DEFAULT_DATABASE_URL;
}

export function isUsingDefaultDatabaseUrl(env: NodeJS.ProcessEnv = process.env): boolean {
  return !env.DATABASE_URL?.trim();
}

export function displayDatabaseUrl(databaseUrl: string): string {
  try {
    const parsed = new URL(databaseUrl);
    if (parsed.username) {
      parsed.username = "REDACTED";
    }
    if (parsed.password) {
      parsed.password = "REDACTED";
    }
    return parsed.toString();
  } catch {
    return databaseUrl.replace(/:\/\/([^:@/]+):([^@/]+)@/, "://REDACTED:REDACTED@");
  }
}

export function createDbConsoleContext(databaseUrl = databaseUrlFromEnv()) {
  const pg = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  const db = drizzlePostgres(pg, { schema });
  const tableInfo = loadTables();
  const tables = Object.fromEntries(tableInfo.map((table) => [table.exportName, table.table]));
  let closed = false;

  async function close() {
    if (closed) return;
    closed = true;
    await pg.end();
  }

  function showTables() {
    const rows = tableInfo.map(({ exportName, tableName }) => ({ exportName, tableName }));
    console.table(rows);
    return rows;
  }

  async function describe(input: string | PgTable) {
    const table = resolveTable(input, tableInfo);
    const rows = await pg`
      select column_name, data_type, is_nullable, column_default
      from information_schema.columns
      where table_schema = 'public' and table_name = ${table.tableName}
      order by ordinal_position
    `;
    console.table(rows);
    return rows;
  }

  async function sample(input: string | PgTable, limit = 10) {
    const table = resolveTable(input, tableInfo);
    const rows = await db.select().from(table.table).limit(limit);
    console.table(rows);
    return rows;
  }

  function one<T>(rows: T[]): T | undefined {
    return rows[0];
  }

  function help() {
    console.log(`Loaded bindings:
  db, pg, schema, tables
  ${tableInfo.map((table) => table.exportName).join(", ")}
  ${Object.keys(operators).join(", ")}

Helpers:
  showTables()
  await describe("requests")
  await sample(requests, 5)
  one(await db.select().from(organizations).limit(1))
  print(value)
  await close()`);
  }

  const bindings: ConsoleBindings = {
    db,
    pg,
    schema,
    tables,
    tableInfo,
    tableNames: tableInfo.map((table) => table.exportName),
    showTables,
    describe,
    sample,
    one,
    print: printValue,
    help,
    close,
    ...operators,
    ...tables
  };

  return {
    bindings,
    close,
    databaseUrl,
    db,
    pg: pg as Sql,
    tableInfo
  };
}

export function printConsoleBanner(context: ReturnType<typeof createDbConsoleContext>) {
  console.log("Proxy DB console");
  console.log(`Connected to ${displayDatabaseUrl(context.databaseUrl)}`);
  console.log(`Loaded ${context.tableInfo.length} tables. Run showTables(), help(), or .tables.`);
  console.log("Examples:");
  console.log("  await sample(requests, 5)");
  console.log("  await db.select().from(organizations).limit(5)");
  console.log("  await db.select().from(requests).where(eq(requests.status, \"completed\"))");
}
