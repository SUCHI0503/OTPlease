import Fastify from "fastify";

const app = Fastify({ logger: true });

app.get("/health", async () => {
  return { status: "ok", service: "otplease-server" };
});

app.listen({ port: 4000, host: "0.0.0.0" });
