import { defineConfig } from "vitest/config";
import { loadEnv } from "vite";

// Real delivery settings that a developer keeps in apps/server/.env (Prisma loads that file by itself). Tests must
// never see them, or a test could send a real message. The fake Twilio credentials in .env.test are kept.
const REAL_PROVIDER_SETTINGS = [
  "SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS",
  "TWILIO_SMS_FROM", "TWILIO_WHATSAPP_FROM", "TWILIO_VOICE_FROM", "TWILIO_WHATSAPP_CONTENT_SID",
];

export default defineConfig({
  test: {
    env: { ...loadEnv("test", process.cwd(), ""), ...Object.fromEntries(REAL_PROVIDER_SETTINGS.map((k) => [k, ""])) },
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
