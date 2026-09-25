import type { FastifyInstance, FastifyReply } from "fastify";
import { ZodError } from "zod";
import { captureError } from "./sentry";

export function sendError(
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
  details?: unknown
) {
  return reply.status(status).send({ error: { code, message, ...(details ? { details } : {}) } });
}

export function registerErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((error, request, reply) => {
    // Bad input caught by Zod
    if (error instanceof ZodError) {
      const details = error.issues.map((issue) => ({
        field: issue.path.join("."),
        message: issue.message,
      }));
      return sendError(reply, 400, "VALIDATION_ERROR", "Invalid request", details);
    }

    // Client mistakes that Fastify detects itself, like malformed JSON
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode && statusCode >= 400 && statusCode < 500) {
      return sendError(reply, statusCode, "BAD_REQUEST", (error as Error).message);
    }

    // Our own bugs: never show details to the caller. In the log we keep the type, code and stack but
    // not the message: database errors can echo the values being written (phone numbers, hashes).
    const err = error as Error & { code?: string };
    request.log.error(
      { type: err.name, code: err.code, stack: err.stack?.split("\n").slice(1).join("\n") },
      "unhandled error"
    );
    captureError(error, { route: request.routeOptions?.url ?? "unmatched" });
    return sendError(reply, 500, "INTERNAL_ERROR", "Something went wrong");
  });

  app.setNotFoundHandler((request, reply) =>
    sendError(reply, 404, "ROUTE_NOT_FOUND", `Route ${request.method} ${request.url} not found`)
  );
}
