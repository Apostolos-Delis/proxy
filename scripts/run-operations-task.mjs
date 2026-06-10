import { spawnSync } from "node:child_process";

const envName = process.env.PROMPT_PROXY_DEPLOY_ENV ?? process.argv[2] ?? "staging";
const operation = process.env.PROMPT_PROXY_OPERATION ?? process.argv[3] ?? "migrate";
if (operation !== "migrate" && operation !== "seed") {
  throw new Error("Operation must be migrate or seed.");
}

const stackName = `prompt-proxy-${envName}-operations`;
const outputPrefix = operation === "seed" ? "Seed" : "Migration";
const outputs = stackOutputs(stackName);
const cluster = requiredOutput(outputs, "OperationsClusterName");
const taskDefinition = requiredOutput(outputs, `${outputPrefix}TaskDefinitionArn`);
const containerName = requiredOutput(outputs, `${outputPrefix}ContainerName`);
const securityGroup = requiredOutput(outputs, "OperationsSecurityGroupId");
const subnets = requiredOutput(outputs, "OperationsSubnetIds").split(",").filter(Boolean);

const run = awsJson([
  "ecs",
  "run-task",
  "--cluster",
  cluster,
  "--task-definition",
  taskDefinition,
  "--launch-type",
  "FARGATE",
  "--network-configuration",
  `awsvpcConfiguration={subnets=[${subnets.join(",")}],securityGroups=[${securityGroup}],assignPublicIp=ENABLED}`
]);
const taskArn = run.tasks?.[0]?.taskArn;
if (!taskArn) {
  throw new Error(`run-task did not return a task ARN: ${JSON.stringify(run)}`);
}

aws(["ecs", "wait", "tasks-stopped", "--cluster", cluster, "--tasks", taskArn]);
const description = awsJson(["ecs", "describe-tasks", "--cluster", cluster, "--tasks", taskArn]);
const task = description.tasks?.[0];
const container = task?.containers?.find((entry) => entry.name === containerName);
if (!container) {
  throw new Error(`Task ${taskArn} did not include container ${containerName}: ${JSON.stringify(description)}`);
}
if (container.exitCode !== 0) {
  throw new Error(`${operation} task ${taskArn} exited with ${container.exitCode}: ${container.reason ?? task.stoppedReason ?? "no reason"}`);
}

console.log(`${operation}_task=${taskArn} exitCode=${container.exitCode}`);

function stackOutputs(name) {
  const response = awsJson(["cloudformation", "describe-stacks", "--stack-name", name]);
  const outputs = response.Stacks?.[0]?.Outputs ?? [];
  return Object.fromEntries(outputs.map((output) => [output.OutputKey, output.OutputValue]));
}

function requiredOutput(outputs, key) {
  const value = outputs[key];
  if (!value) throw new Error(`Missing ${key} output from ${stackName}`);
  return value;
}

function awsJson(args) {
  const result = aws([...args, "--output", "json"], "pipe");
  return JSON.parse(result.stdout.toString("utf8"));
}

function aws(args, stdio = "inherit") {
  const fullArgs = regionArgs().concat(args);
  const result = spawnSync("aws", fullArgs, { stdio });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`aws ${fullArgs.join(" ")} failed with exit code ${result.status}`);
  }
  return result;
}

function regionArgs() {
  return process.env.AWS_REGION ? ["--region", process.env.AWS_REGION] : [];
}
