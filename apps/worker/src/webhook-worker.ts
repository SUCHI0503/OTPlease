import { Worker } from "bullmq";
import { env } from "../../server/src/lib/env";
import { prisma } from "../../server/src/lib/prisma";
import { decrypt } from "../../server/src/lib/secretbox";
import { postWebhook } from "../../server/src/lib/webhook-http";
import {
  EVENT_ID_HEADER,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  signWebhook,
} from "../../server/src/lib/webhook-signature";
import { bullConnection } from "../../server/src/queue/otp-queue";
import { WEBHOOK_QUEUE, type WebhookJobData } from "../../server/src/queue/webhook-queue";

/**
 * Delivers webhook events. Every attempt is signed with a fresh timestamp but
 * keeps the same event id, so a receiver can tell a retry from a new event.
 * Any non-2xx answer or network error makes BullMQ retry with backoff.
 */
export function createWebhookWorker(): Worker<WebhookJobData> {
  const worker = new Worker<WebhookJobData>(
    WEBHOOK_QUEUE,
    async (job) => {
      const { logId, endpointId, eventId, type, applicationId, createdAt, data } = job.data;
      const attempts = job.attemptsMade + 1;
      const isLast = attempts >= (job.opts.attempts ?? 1);

      const endpoint = await prisma.webhookEndpoint.findUnique({ where: { id: endpointId } });
      if (!endpoint || endpoint.revokedAt) {
        await prisma.webhookLog.update({ where: { id: logId }, data: { status: "cancelled", attempts } });
        return;
      }

      const body = JSON.stringify({ id: eventId, type, createdAt, applicationId, data });
      const { timestamp, signature } = signWebhook(decrypt(endpoint.secretEnc), body);

      try {
        const status = await postWebhook(
          endpoint.url,
          {
            [SIGNATURE_HEADER]: signature,
            [TIMESTAMP_HEADER]: timestamp,
            [EVENT_ID_HEADER]: eventId,
            "user-agent": "OTPlease-Webhooks/1.0",
          },
          body,
          { allowPrivate: env.WEBHOOK_ALLOW_PRIVATE_URLS }
        );
        if (status < 200 || status >= 300) throw new Error(`receiver answered http ${status}`);
        await prisma.webhookLog.update({
          where: { id: logId },
          data: { status: "success", attempts, lastStatusCode: status, lastError: null },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "delivery failed";
        const statusCode = Number(message.match(/http (\d+)/)?.[1]) || null;
        await prisma.webhookLog.update({
          where: { id: logId },
          data: {
            status: isLast ? "failed" : "pending",
            attempts,
            lastStatusCode: statusCode,
            lastError: message.slice(0, 200),
          },
        });
        throw err;
      }
    },
    { connection: bullConnection(), concurrency: 10 }
  );
  worker.on("error", (err) => console.error(`[webhook worker] ${err.message}`));
  return worker;
}
