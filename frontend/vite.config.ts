import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

const BACKEND_URL = "http://127.0.0.1:3000";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": BACKEND_URL,
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
  },
});
