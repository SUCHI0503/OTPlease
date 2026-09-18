import { buildApp } from "./app";

const app = buildApp();
app.listen({ port: 4000, host: "0.0.0.0" });
