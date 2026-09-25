import client from "prom-client";

/**
 * Prometheus metrics for the API process. Each app gets its own registry (tests build many apps in one process).
 * Labels are kept to a few fixed values: the route TEMPLATE, never the URL, and never a phone number or id,
 * so the number of series stays small and nothing personal is exposed.
 */
export function createMetrics() {
  const registry = new client.Registry();
  client.collectDefaultMetrics({ register: registry });

  const httpDuration = new client.Histogram({
    name: "http_request_duration_seconds",
    help: "API request duration",
    labelNames: ["method", "route", "status"] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [registry],
  });
  const otpRequests = new client.Counter({
    name: "otp_requests_total",
    help: "OTP requests accepted, by requested channel",
    labelNames: ["channel"] as const,
    registers: [registry],
  });
  const otpVerifications = new client.Counter({
    name: "otp_verifications_total",
    help: "OTP verification attempts, by result",
    labelNames: ["result"] as const,
    registers: [registry],
  });
  const queueJobs = new client.Gauge({
    name: "otp_queue_jobs",
    help: "Jobs in the OTP sending queue, by state (a growing waiting count means the worker is behind or down)",
    labelNames: ["state"] as const,
    registers: [registry],
  });

  return { registry, httpDuration, otpRequests, otpVerifications, queueJobs };
}

export type Metrics = ReturnType<typeof createMetrics>;
