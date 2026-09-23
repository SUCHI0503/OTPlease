import { defineConfig } from "vitest/config";
import { loadEnv } from "vite";

export default defineConfig({
  test: {
    env: loadEnv("test", process.cwd(), ""),
    fileParallelism: false,
    setupFiles: ["../../tests/setup.ts"],
    include: ["../../tests/**/*.test.ts"],
  },
});
