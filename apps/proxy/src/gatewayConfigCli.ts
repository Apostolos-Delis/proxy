import type { GatewayConfigAdminService } from "./persistence/gatewayConfigAdmin.js";
import { parseGatewayConfigDocument } from "./persistence/gatewayConfigDocument.js";
import {
  applyGatewayConfig,
  planGatewayConfig,
  type GatewayConfigPlan
} from "./persistence/gatewayConfigPlan.js";
import { idSchema, parseGatewayBody } from "./persistence/gatewayConfigSchemas.js";
import { GatewayConfigAdminError } from "./persistence/gatewayConfigTypes.js";

export const GATEWAY_CONFIG_CLI_VERSION = "1.0.0";

export type GatewayConfigCliDependencies = {
  readFile(path: string): Promise<string>;
  openService(): Promise<{
    service: GatewayConfigAdminService;
    close(): Promise<void>;
  }>;
  stdout(value: string): void;
};

type GatewayConfigCliOptions = {
  command: "plan" | "apply";
  file: string;
  actorUserId?: string;
  json: boolean;
};

export async function runGatewayConfigCli(args: string[], dependencies: GatewayConfigCliDependencies) {
  const options = parseGatewayConfigCliArgs(args);
  if (options === "help") {
    dependencies.stdout(gatewayConfigCliHelp());
    return;
  }
  if (options === "version") {
    dependencies.stdout(`${GATEWAY_CONFIG_CLI_VERSION}\n`);
    return;
  }
  const document = parseGatewayConfigDocument(await dependencies.readFile(options.file));
  const connection = await dependencies.openService();
  try {
    const plan = options.command === "plan"
      ? await planGatewayConfig(connection.service, document)
      : await applyGatewayConfig(connection.service, document, options.actorUserId!);
    dependencies.stdout(formatGatewayConfigPlan(plan, options.command, options.json));
  } finally {
    await connection.close();
  }
}

export function parseGatewayConfigCliArgs(args: string[]): GatewayConfigCliOptions | "help" | "version" {
  if (args.includes("--help") || args.includes("-h")) return "help";
  if (args.includes("--version")) return "version";
  const command = args[0];
  if (command !== "plan" && command !== "apply") throw cliError("Expected plan or apply as the first argument.");
  let file: string | undefined;
  let actorUserId: string | undefined;
  let json = false;
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--actor-user-id") {
      if (actorUserId !== undefined) throw cliError("--actor-user-id may only be specified once.");
      actorUserId = args[index + 1];
      if (!actorUserId || actorUserId.startsWith("-")) throw cliError("--actor-user-id requires a value.");
      index += 1;
      continue;
    }
    if (argument.startsWith("-")) throw cliError(`Unknown option: ${argument}`);
    if (file !== undefined) throw cliError("Exactly one TOML file is required.");
    file = argument;
  }
  if (!file) throw cliError("Exactly one TOML file is required.");
  if (command === "apply" && !actorUserId) throw cliError("apply requires --actor-user-id.");
  if (command === "plan" && actorUserId) throw cliError("--actor-user-id is only valid with apply.");
  if (actorUserId) actorUserId = parseGatewayBody(idSchema, actorUserId, "invalid_actor_user_id");
  return { command, file, actorUserId, json };
}

export function formatGatewayConfigPlan(
  plan: GatewayConfigPlan,
  command: "plan" | "apply",
  json: boolean
) {
  if (json) {
    return `${JSON.stringify({
      scope: plan.scope,
      changeCount: plan.changes.length,
      changes: plan.changes
    }, null, 2)}\n`;
  }
  const verb = command === "apply" ? "Applied" : "Plan";
  if (plan.changes.length === 0) return `${verb}: no changes.\n`;
  const lines = plan.changes.map((change) => {
    const fields = change.fields?.length ? ` (${change.fields.join(", ")})` : "";
    return `${change.action.toUpperCase()} ${change.resource} ${change.reference}${fields}`;
  });
  return `${verb}: ${plan.changes.length} change${plan.changes.length === 1 ? "" : "s"}.\n${lines.join("\n")}\n`;
}

export function gatewayConfigCliHelp() {
  return [
    "Usage:",
    "  pnpm --filter @proxy/proxy gateway-config plan <file> [--json]",
    "  pnpm --filter @proxy/proxy gateway-config apply <file> --actor-user-id <id> [--json]",
    "",
    "Commands:",
    "  plan   Validate and print the database diff without writing",
    "  apply  Validate and atomically apply the database diff",
    "",
    "Options:",
    "  --actor-user-id <id>  Audit actor required by apply",
    "  --json                Emit machine-readable output",
    "  --help, -h            Show help",
    "  --version             Show version",
    ""
  ].join("\n");
}

function cliError(message: string) {
  return new GatewayConfigAdminError("invalid_gateway_config_command", 400, [{ path: "arguments", message }]);
}
