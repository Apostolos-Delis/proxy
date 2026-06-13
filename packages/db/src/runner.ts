import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { inspect } from "node:util";

import { formatRunnerResult, parseRunnerArgs, runnerUsage, runSource } from "./runnerCore.js";

type RunnerModule = {
  default?: unknown;
  run?: unknown;
};

async function runFile(input: string, bindings: Record<string, unknown>, context: unknown) {
  const baseDir = process.env.INIT_CWD ?? process.cwd();
  const resolved = resolve(baseDir, input);
  const module = await import(pathToFileURL(resolved).href) as RunnerModule;
  const run = typeof module.default === "function" ? module.default : module.run;
  if (typeof run !== "function") {
    throw new Error("Runner files must export a default function or named run function.");
  }
  return run(bindings, context);
}

async function main() {
  const options = parseRunnerArgs(process.argv.slice(2));
  if (options.mode === "help") {
    console.log(runnerUsage());
    return;
  }

  const { createDbConsoleContext, isUsingDefaultDatabaseUrl } = await import("./consoleContext.js");
  const context = createDbConsoleContext();

  try {
    if (isUsingDefaultDatabaseUrl()) {
      console.error("DATABASE_URL is not set; using the local Prompt Proxy Postgres default.");
    }

    const result = options.mode === "file"
      ? await runFile(options.input, context.bindings, context)
      : await runSource(context.bindings, options.input);
    const output = formatRunnerResult(result, options.json);
    if (output) {
      if (options.json) {
        console.log(output);
      } else {
        console.log(inspect(result, { colors: true, depth: 8, maxArrayLength: 100 }));
      }
    }
  } finally {
    await context.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
