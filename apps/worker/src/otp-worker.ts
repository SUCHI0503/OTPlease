import { Worker } from "bullmq";
import { prisma } from "../../server/src/lib/prisma";
import { decrypt } from "../../server/src/lib/secretbox";
import { OTP_QUEUE, bullConnection, type OtpJobData } from "../../server/src/queue/otp-queue";
import type { ProviderRegistry } from "../../server/src/providers";

/**
 * Sends queued OTP messages. Tries each channel in the job's chain in order and
 * stops at the first success. If every channel fails, the error makes BullMQ
 * retry the whole chain with backoff; the last retry marks the delivery failed.
 */
export function createOtpWorker(providers: ProviderRegistry): Worker<OtpJobData> {
  return new Worker<OtpJobData>(
    OTP_QUEUE,
    async (job) => {
      const { chain, to, codeEnc, deliveryId } = job.data;
      const code = decrypt(codeEnc);
      const attempts = job.attemptsMade + 1;
      let lastError = "unknown error";

      for (const channel of chain) {
        try {
          const result = await providers[channel].send({ channel, to, code });
          await prisma.delivery.update({
            where: { id: deliveryId },
            data: { status: "sent", channel, providerMessageId: result.providerMessageId, attempts, error: null },
          });
          return;
        } catch (err) {
          lastError = `${channel}: ${err instanceof Error ? err.message : "send failed"}`;
        }
      }

      const isLastAttempt = attempts >= (job.opts.attempts ?? 1);
      await prisma.delivery.update({
        where: { id: deliveryId },
        data: { status: isLastAttempt ? "failed" : "queued", attempts, error: lastError },
      });
      throw new Error(lastError);
    },
    { connection: bullConnection(), concurrency: 10 }
  );
}
