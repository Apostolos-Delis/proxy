import { runDatabaseMigrations } from "./migrate-runner.js";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required to run migrations.");
}

const result = await runDatabaseMigrations({
  databaseUrl,
  onApplied: (filename) => {
    console.log(`applied ${filename}`);
  }
});

if (result.appliedFiles.length === 0) {
  console.log("database already up to date");
}
