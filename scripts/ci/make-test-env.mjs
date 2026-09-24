#!/usr/bin/env node
// CI only: writes apps/server/.env.test with random secrets and the throwaway test database and Redis /1.
// Twilio values are fake and unreachable: tests always use the mock provider. Nothing here is a real credential.
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";

const secret = () => randomBytes(32).toString("hex");
const lines = [
  "DATABASE_URL=postgresql://otplease:otplease@localhost:5432/otplease_test",
  "REDIS_URL=redis://localhost:6379/1",
  `OTP_HASH_SECRET=${secret()}`,
  `JWT_SECRET=${secret()}`,
  `ADMIN_TOKEN=${secret()}`,
  "TWILIO_ACCOUNT_SID=ACtest00000000000000000000000000",
  `TWILIO_AUTH_TOKEN=${secret()}`,
  "TWILIO_STATUS_CALLBACK_URL=http://localhost:4000/webhooks/twilio/status",
  "WEBHOOK_ALLOW_PRIVATE_URLS=true",
];
writeFileSync("apps/server/.env.test", lines.join("\n") + "\n", { mode: 0o600 });
console.log("wrote apps/server/.env.test");
