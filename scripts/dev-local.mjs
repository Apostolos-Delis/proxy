import { spawn } from "node:child_process";
import { copyFile, readFile, stat } from "node:fs/promises";
import net from "node:net";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";

const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const cwd = process.cwd();
const env = await localEnv();
const defaultDatabaseUrl = `postgres://prompt_proxy:prompt_proxy@localhost:${env.POSTGRES_PORT ?? "55432"}/prompt_proxy`;
env.POSTGRES_PORT ??= "55432";
env.DATABASE_URL ??= defaultDatabaseUrl;
env.PROMPT_PROXY_TOKEN ??= "dev-proxy-token";
env.ALLOW_DEV_PROXY_TOKEN_FALLBACK ??= "true";
env.DEFAULT_ORGANIZATION_ID ??= "local";
const databaseUrl = env.DATABASE_URL;
const proxyUrl = `http://127.0.0.1:${env.PORT ?? "8787"}`;
const webUrl = webDevUrl(env);
const webPort = new URL(webUrl).port || "5173";
const children = new Set();
let shuttingDown = false;

function log(message) {
  console.log(`[prompt-proxy-local] ${message}`);
}

async function localEnv() {
  await ensureEnvFile();
  return {
    ...(await readEnvFile(".env")),
    ...process.env
  };
}

async function ensureEnvFile() {
  try {
    await stat(".env");
  } catch (error) {
    if (!error || typeof error !== "object" || error.code !== "ENOENT") throw error;
    await copyFile(".env.example", ".env");
    log("created .env from .env.example");
  }
}

async function readEnvFile(path) {
  let raw = "";
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (!error || typeof error !== "object" || error.code !== "ENOENT") throw error;
  }

  const parsed = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^"(.*)"$/, "$1");
    parsed[key] = value;
  }
  return parsed;
}

function webDevUrl(localEnv) {
  const base = new URL(localEnv.VITE_PROMPT_PROXY_WEB_URL ?? "http://127.0.0.1:5173");
  return base.toString().replace(/\/$/, "");
}

async function runPnpm(label, args) {
  return runCommand(label, pnpmCommand, args);
}

async function runCommand(label, command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(output);
        return;
      }
      reject(new Error(`[${label}] exited with code ${code ?? 1}\n${output}`.trim()));
    });
  });
}

function spawnLongRunning(label, args, childEnv = env) {
  const child = spawn(pnpmCommand, args, {
    cwd,
    env: childEnv,
    stdio: "inherit"
  });
  children.add(child);

  child.on("exit", (code, signal) => {
    children.delete(child);
    if (shuttingDown) return;
    const reason = signal ? `${label} exited from signal ${signal}` : `${label} exited with code ${code ?? 1}`;
    console.error(`[prompt-proxy-local] ${reason}`);
    void shutdown(code ?? 1);
  });

  child.on("error", (error) => {
    if (shuttingDown) return;
    console.error(`[prompt-proxy-local] failed to start ${label}:`, error);
    void shutdown(1);
  });

  return child;
}

async function ensurePostgres() {
  log("starting local Postgres");
  try {
    await runPnpm("db:up", ["db:up"]);
  } catch (error) {
    if (await databaseTcpReachable(databaseUrl)) {
      log("Docker Compose failed, but DATABASE_URL is reachable; reusing existing Postgres");
      return;
    }
    if (await commandExists("colima")) {
      log("Docker is unavailable; starting Colima");
      await runCommand("colima start", "colima", ["start"]);
      await runPnpm("db:up", ["db:up"]);
    } else {
      throw error;
    }
  }

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await databaseTcpReachable(databaseUrl)) return;
    await sleep(500);
  }

  throw new Error("Timed out waiting for Postgres");
}

async function commandExists(command) {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-lc", `command -v ${command}`], {
      stdio: "ignore"
    });
    child.on("close", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}

async function databaseTcpReachable(url) {
  const parsed = new URL(url);
  const host = parsed.hostname || "127.0.0.1";
  const port = Number(parsed.port || 5432);

  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(1_500);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

async function waitForHttp(url, validate, label) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(3_000)
      });
      if (response.ok && (await validate(response))) return;
    } catch {
      // retry
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;

  for (const child of children) {
    child.kill("SIGTERM");
  }

  await sleep(1_000);

  for (const child of children) {
    if (!child.killed) child.kill("SIGKILL");
  }

  process.exit(exitCode);
}

process.on("SIGINT", () => {
  void shutdown(0);
});

process.on("SIGTERM", () => {
  void shutdown(0);
});

process.on("uncaughtException", (error) => {
  console.error("[prompt-proxy-local] uncaught exception:", error);
  void shutdown(1);
});

process.on("unhandledRejection", (error) => {
  console.error("[prompt-proxy-local] unhandled rejection:", error);
  void shutdown(1);
});

async function main() {
  await ensurePostgres();

  log("building runtime packages");
  await runPnpm("build:runtime", ["build:runtime"]);

  log("applying migrations");
  await runPnpm("db:migrate", ["db:migrate"]);

  log("seeding baseline data");
  await runPnpm("db:seed", ["db:seed"]);

  log("starting proxy");
  spawnLongRunning("proxy", ["dev:proxy"], env);

  log("starting web app");
  spawnLongRunning(
    "web",
    ["--filter", "@prompt-proxy/web", "dev", "--", "--port", webPort, "--strictPort"],
    {
      ...env,
      VITE_PROMPT_PROXY_API_BASE: env.VITE_PROMPT_PROXY_API_BASE ?? proxyUrl,
      VITE_PROMPT_PROXY_TOKEN: env.VITE_PROMPT_PROXY_TOKEN ?? env.PROMPT_PROXY_TOKEN ?? "dev-proxy-token"
    }
  );

  await waitForHttp(
    `${proxyUrl}/healthz`,
    async (response) => {
      const body = await response.json().catch(() => null);
      return body?.status === "ok";
    },
    "proxy"
  );

  await waitForHttp(webUrl, async () => true, "web app");

  log(`proxy ready: ${proxyUrl}`);
  log(`web ready: ${webUrl}`);
}

main().catch((error) => {
  console.error("[prompt-proxy-local] failed to start local mode:", error);
  void shutdown(1);
});
