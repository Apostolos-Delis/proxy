import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    exclude: ["dist/**", "node_modules/**"],
    // PGlite-backed tests boot a fresh instance and apply the full migration
    // chain, which routinely exceeds the 5s default under parallel load.
    testTimeout: 30000
  }
});
