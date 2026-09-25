import * as Sentry from "@sentry/node";
import { env } from "./env";

let enabled = false;

/** Last line of defence before an event leaves the process: no request, no user, no exception messages. */
export function scrubEvent<T extends { request?: unknown; user?: unknown; exception?: { values?: { value?: string }[] } }>(event: T): T {
  delete event.request;
  delete event.user;
  for (const exception of event.exception?.values ?? []) exception.value = "[message removed]";
  return event;
}

/**
 * Error reporting to Sentry. It does nothing unless SENTRY_DSN is set. Reports carry no personal data: automatic data
 * collection is off, request details are dropped, and exception messages are replaced (database errors can echo the phone
 * numbers or hashes being written). What remains is the error type, code, stack trace and our own tags.
 */
export function initSentry(service: "api" | "worker") {
  if (!env.SENTRY_DSN || enabled) return;
  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.DEPLOY_ENV,
    release: env.RELEASE,
    // Nothing personal is collected automatically: no user info, cookies, headers, request bodies or query strings
    dataCollection: { userInfo: false, cookies: false, httpHeaders: false, httpBodies: [], urlQueryParams: false },
    tracesSampleRate: 0,
    beforeSend: scrubEvent,
  });
  Sentry.setTag("service", service);
  enabled = true;
}

/** Reports an unexpected error with the message stripped (only type, code and stack travel). */
export function captureError(error: unknown, tags: Record<string, string> = {}) {
  if (!enabled) return;
  const err = error as Error & { code?: string };
  const safe = new Error(err.code ?? err.name ?? "error");
  safe.name = err.name ?? "Error";
  safe.stack = `${safe.name}: [message removed]\n${err.stack?.split("\n").slice(1).join("\n") ?? ""}`;
  Sentry.captureException(safe, { tags });
}

/** Reports a message we wrote ourselves (it must never contain a phone number, code or token). */
export function captureFailure(message: string, tags: Record<string, string> = {}) {
  if (!enabled) return;
  Sentry.captureMessage(message, { level: "error", tags });
}

/** Sends anything still queued, so a crash or shutdown does not lose the last reports. */
export async function flushSentry() {
  if (enabled) await Sentry.flush(2000);
}
