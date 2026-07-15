import { readFile } from "node:fs/promises";

import { createPostgresDatabaseConnection } from "@proxy/db";

import { loadConfig } from "../src/config.js";
import { runGatewayConfigCli } from "../src/gatewayConfigCli.js";
import { AdminMutationError } from "../src/persistence/adminErrors.js";
import { createDatabasePersistence } from "../src/persistence/index.js";

try {
  await runGatewayConfigCli(process.argv.slice(2), {
    readFile: (path) => readFile(path, "utf8"),
    openService: async () => {
      const config = loadConfig(process.env);
      if (!config.databaseUrl) throw new Error("DATABASE_URL is required.");
      const connection = createPostgresDatabaseConnection(config.databaseUrl, { max: 1 });
      try {
        const persistence = createDatabasePersistence(connection.db, config, true);
        return {
          service: persistence.gatewayConfigAdmin,
          close: connection.close
        };
      } catch (error) {
        await connection.close();
        throw error;
      }
    },
    stdout: (value) => process.stdout.write(value)
  });
} catch (error) {
  const json = process.argv.includes("--json");
  const payload = errorPayload(error);
  process.stderr.write(json ? `${JSON.stringify(payload)}\n` : formatError(payload));
  process.exitCode = 1;
}

function errorPayload(error: unknown) {
  if (error instanceof AdminMutationError) {
    return { error: error.message, issues: error.issues ?? [] };
  }
  return { error: error instanceof Error ? error.message : "gateway_config_command_failed", issues: [] };
}

function formatError(payload: ReturnType<typeof errorPayload>) {
  const issues = payload.issues.map((issue) => `  ${issue.path}: ${issue.message}`).join("\n");
  return `${payload.error}${issues ? `\n${issues}` : ""}\n`;
}
