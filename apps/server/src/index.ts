import { env } from "./lib/env";
import { buildApp } from "./app";

const app = buildApp();

if (env.ALLOW_MOCK_PROVIDERS) {
  app.log.warn("STAGING: WhatsApp, SMS and voice use the mock provider and are NOT delivered");
}

// Finish in-flight requests and close Redis/Postgres/queues cleanly when the platform stops us
let closing = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    // Process managers can deliver the signal more than once (npx, tsx and node all forward it)
    if (closing) return;
    closing = true;
    app.log.info({ signal }, "shutting down");
    await app.close();
    process.exit(0);
  });
}

app.listen({ port: env.PORT, host: "0.0.0.0" });
