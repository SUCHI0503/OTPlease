import { Worker } from "bullmq";
import { decrypt } from "../../server/src/lib/secretbox";
import { OTP_QUEUE, bullConnection, type OtpJobData } from "../../server/src/queue/otp-queue";
import type { ProviderRegistry } from "../../server/src/providers";

/** Sends queued OTP messages. A thrown error makes BullMQ retry with backoff. */
export function createOtpWorker(providers: ProviderRegistry): Worker<OtpJobData> {
  return new Worker<OtpJobData>(
    OTP_QUEUE,
    async (job) => {
      const { channel, to, codeEnc } = job.data;
      await providers[channel].send({ channel, to, code: decrypt(codeEnc) });
    },
    { connection: bullConnection(), concurrency: 10 }
  );
}
