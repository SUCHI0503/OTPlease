import { env } from "./lib/env";
import { buildApp } from "./app";

const app = buildApp();
app.listen({ port: env.PORT, host: "0.0.0.0" });
