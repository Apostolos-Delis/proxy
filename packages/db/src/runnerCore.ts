type RunnerMode = "source" | "file" | "help";

export type RunnerOptions = {
  mode: RunnerMode;
  input: string;
  json: boolean;
};

type AsyncFunctionType = new (...args: string[]) => (...values: unknown[]) => Promise<unknown>;

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as AsyncFunctionType;

export function runnerUsage(): string {
  return `Usage:
  pnpm db:runner -- 'await db.select().from(organizations).limit(5)'
  pnpm db:runner -- --file ./scripts/db-task.ts

The runner preloads db, pg, schema, every table binding, and common Drizzle helpers.`;
}

export function parseRunnerArgs(args: string[]): RunnerOptions {
  const remaining = [...args];
  let json = true;
  let file: string | null = null;

  while (remaining.length > 0) {
    const arg = remaining[0];
    if (arg === "--") {
      remaining.shift();
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      return { mode: "help", input: "", json };
    }
    if (arg === "--inspect") {
      json = false;
      remaining.shift();
      continue;
    }
    if (arg === "--json") {
      json = true;
      remaining.shift();
      continue;
    }
    if (arg === "--file") {
      remaining.shift();
      file = remaining.shift() ?? null;
      if (!file) {
        throw new Error("--file requires a path.");
      }
      continue;
    }
    break;
  }

  if (file) {
    if (remaining.length > 0) {
      throw new Error("--file cannot be combined with inline source.");
    }
    return { mode: "file", input: file, json };
  }

  const source = remaining.join(" ").trim();
  if (!source) {
    throw new Error(runnerUsage());
  }
  return { mode: "source", input: source, json };
}

export async function runSource(bindings: Record<string, unknown>, source: string): Promise<unknown> {
  const names = Object.keys(bindings);
  const values = names.map((name) => bindings[name]);
  let fn: (...values: unknown[]) => Promise<unknown>;

  try {
    fn = new AsyncFunction(...names, `return (${source});`);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    fn = new AsyncFunction(...names, source);
  }

  return fn(...values);
}

export function formatRunnerResult(value: unknown, json: boolean): string | null {
  if (value === undefined) return null;
  if (!json) {
    return String(value);
  }
  return JSON.stringify(value, (_key, current) => {
    if (typeof current === "bigint") {
      return current.toString();
    }
    return current;
  }, 2);
}
