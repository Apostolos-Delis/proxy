import repl from "node:repl";

import {
  createDbConsoleContext,
  isUsingDefaultDatabaseUrl,
  printConsoleBanner
} from "./consoleContext.js";

function runReplCommand(server: repl.REPLServer, task: () => Promise<void> | void) {
  void Promise.resolve()
    .then(task)
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
    })
    .finally(() => {
      server.displayPrompt();
    });
}

const context = createDbConsoleContext();

if (isUsingDefaultDatabaseUrl()) {
  console.log("DATABASE_URL is not set; using the local Proxy Postgres default.");
}

printConsoleBanner(context);

const server = repl.start({
  prompt: "prompt(db)> ",
  useColors: true,
  ignoreUndefined: true,
  preview: true
});

Object.assign(server.context, context.bindings);

server.defineCommand("tables", {
  help: "List loaded Drizzle table bindings",
  action() {
    runReplCommand(server, () => {
      const showTables = server.context.showTables as () => void;
      showTables();
    });
  }
});

server.defineCommand("schema", {
  help: "Show columns for a table: .schema requests",
  action(input: string) {
    runReplCommand(server, async () => {
      const describe = server.context.describe as (table: string) => Promise<void>;
      await describe(input);
    });
  }
});

server.defineCommand("sample", {
  help: "Show sample rows for a table: .sample requests 5",
  action(input: string) {
    runReplCommand(server, async () => {
      const [table, rawLimit] = input.trim().split(/\s+/);
      if (!table) {
        throw new Error("Usage: .sample <table> [limit]");
      }
      const limit = rawLimit ? Number(rawLimit) : 10;
      if (!Number.isInteger(limit) || limit <= 0) {
        throw new Error("Limit must be a positive integer.");
      }
      const sample = server.context.sample as (table: string, limit?: number) => Promise<void>;
      await sample(table, limit);
    });
  }
});

server.defineCommand("bindings", {
  help: "Print loaded binding names",
  action() {
    runReplCommand(server, () => {
      console.log(Object.keys(context.bindings).sort().join(", "));
    });
  }
});

server.on("exit", () => {
  void context.close().finally(() => {
    console.log("Database connection closed.");
  });
});
