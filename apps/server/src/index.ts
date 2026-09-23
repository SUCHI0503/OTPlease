import { env } from "./lib/env";
import { buildApp } from "./app";

const app = buildApp();

// Finish in-flight requests and close Redis/Postgres/queues cleanly when the platform stops us
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    app.log.info({ signal }, "shutting down");
    await app.close();
    process.exit(0);
  });
}

app.listen({ port: env.PORT, host: "0.0.0.0" });
