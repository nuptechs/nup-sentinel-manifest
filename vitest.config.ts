import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

// Config de testes de componente/lógica do client (jsdom). Separada da
// vite.config.ts de build para não tocar o `root: client` do bundler nem o
// script `test` (tsx --test) do server.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "client", "src"),
      "@shared": path.resolve(import.meta.dirname, "shared"),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    include: ["client/src/**/*.test.{ts,tsx}"],
    setupFiles: ["./client/src/test-setup.ts"],
  },
});
