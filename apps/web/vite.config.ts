import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const proxyTarget = process.env.VITE_PROMPT_PROXY_API_BASE || "http://127.0.0.1:8787";

export default defineConfig(({ command }) => ({
  plugins: [react()],
  server: command === "serve"
    ? {
      proxy: {
        "/admin": {
          target: proxyTarget,
          changeOrigin: true
        }
      }
    }
    : undefined,
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          charts: ["recharts"]
        }
      }
    }
  }
}));
