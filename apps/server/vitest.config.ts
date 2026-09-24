import { defineConfig } from "vitest/config";
import { loadEnv } from "vite";

export default defineConfig({
  test: {
    env: loadEnv("test", process.cwd(), ""),
    fileParallelism: false,
    setupFiles: ["../../tests/setup.ts"],
    include: ["../../tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      // The worker app lives next to the server, outside this config's root
      allowExternal: true,
      // Measured over the server and worker source, from all test levels together
      include: ["src/**/*.ts", "**/apps/worker/src/**/*.ts"],
      exclude: ["**/src/index.ts"],
      reporter: ["text-summary", "text", "json-summary"],
      reportsDirectory: "./coverage",
      // A floor, not a target: a drop below it means new code shipped without tests
      thresholds: { lines: 90, statements: 90, functions: 90, branches: 80 },
    },
  },
});
