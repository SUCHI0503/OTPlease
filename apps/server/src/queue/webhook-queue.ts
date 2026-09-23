import crypto from "node:crypto";
import { Queue } from "bullmq";
import type { PrismaClient } from "@prisma/client";
import { bullConnection } from "./otp-queue";

export const WEBHOOK_QUEUE = "webhooks";

export const WEBHOOK_EVENTS = ["otp.verified", "device.new", "risk.challenged", "risk.blocked", "delivery.sent", "delivery.delivered", "delivery.failed"] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENTS)[number];

export interface WebhookJobData {
  logId: string;
  endpointId: string;
  eventId: string;
  type: WebhookEventType;
  applicationId: string;
  createdAt: string;
  /** Never contains OTP codes or full phone numbers */
  data: Record<string, unknown>;
}

export function createWebhookQueue(opts: { attempts?: number; backoffMs?: number } = {}): Queue<WebhookJobData> {
  return new Queue<WebhookJobData>(WEBHOOK_QUEUE, {
    connection: bullConnection(),
    defaultJobOptions: {
      attempts: opts.attempts ?? 6,
      backoff: { type: "exponential", delay: opts.backoffMs ?? 5000 },
      removeOnComplete: true,
      removeOnFail: { age: 3600 },
    },
  });
}

export type WebhookEmitter = (
  applicationId: string,
  type: WebhookEventType,
  data: Record<string, unknown>
) => Promise<void>;

/**
 * Queues one signed delivery per subscribed endpoint. The event id is shared, so receivers can dedupe.
 * Never throws: a webhook problem must not fail a login, or make the OTP worker resend a message.
 */
export function createWebhookEmitter(prisma: PrismaClient, queue: Queue<WebhookJobData>): WebhookEmitter {
  return async (applicationId, type, data) => {
    try {
      await enqueue(applicationId, type, data);
    } catch (err) {
      console.error(`[webhooks] could not queue ${type}: ${err instanceof Error ? err.message : "unknown error"}`);
    }
  };

  async function enqueue(applicationId: string, type: WebhookEventType, data: Record<string, unknown>) {
    const endpoints = await prisma.webhookEndpoint.findMany({
      where: { applicationId, revokedAt: null, events: { has: type } },
      select: { id: true },
    });
    if (endpoints.length === 0) return;

    const eventId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    for (const endpoint of endpoints) {
      const log = await prisma.webhookLog.create({
        data: { applicationId, endpointId: endpoint.id, eventId, type },
      });
      await queue.add("deliver", { logId: log.id, endpointId: endpoint.id, eventId, type, applicationId, createdAt, data });
    }
  }
}
