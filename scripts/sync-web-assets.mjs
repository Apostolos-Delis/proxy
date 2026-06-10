import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const bucket = process.env.PROMPT_PROXY_WEB_BUCKET;
const prefix = (process.env.PROMPT_PROXY_WEB_PREFIX ?? "").replace(/^\/+|\/+$/g, "");
const dist = process.env.PROMPT_PROXY_WEB_DIST ?? "apps/web/dist";
const dryRun = process.env.PROMPT_PROXY_WEB_SYNC_DRY_RUN === "true";

if (!bucket) {
  throw new Error("PROMPT_PROXY_WEB_BUCKET is required.");
}

if (!existsSync(join(dist, "index.html"))) {
  throw new Error(`Missing ${join(dist, "index.html")}; run pnpm build:web:aws first.`);
}

const destination = prefix ? `s3://${bucket}/${prefix}` : `s3://${bucket}`;
const indexDestination = `${destination}/index.html`;

runAws([
  "s3",
  "sync",
  dist,
  destination,
  "--delete",
  "--exclude",
  "index.html",
  "--cache-control",
  "public,max-age=31536000,immutable",
  ...dryRunFlag()
]);
runAws([
  "s3",
  "cp",
  join(dist, "index.html"),
  indexDestination,
  "--cache-control",
  "no-cache,max-age=0,must-revalidate",
  "--content-type",
  "text/html",
  ...dryRunFlag()
]);

function dryRunFlag() {
  return dryRun ? ["--dryrun"] : [];
}

function runAws(args) {
  const result = spawnSync("aws", args, {
    stdio: "inherit"
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`aws ${args.join(" ")} failed with exit code ${result.status}`);
  }
}
