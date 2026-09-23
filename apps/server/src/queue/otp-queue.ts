import { Queue, type ConnectionOptions } from "bullmq";
import { env } from "../lib/env";
import { encrypt } from "../lib/secretbox";
import type { OtpChannel } from "../providers/types";

export const OTP_QUEUE = "otp-send";
export const MAINTENANCE_QUEUE = "maintenance";

export interface OtpJobData {
  channel: OtpChannel;
  to: string;
  /** Encrypted with secretbox, never plaintext in Redis */
  codeEnc: string;
}

/** BullMQ wants its own connection settings; it needs maxRetriesPerRequest: null for workers. */
export function bullConnection(): ConnectionOptions {
  const url = new URL(env.REDIS_URL);
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    password: url.password || undefined,
    db: Number(url.pathname.slice(1) || 0),
    maxRetriesPerRequest: null,
  };
}

export function createOtpQueue(): Queue<OtpJobData> {
  return new Queue<OtpJobData>(OTP_QUEUE, {
    connection: bullConnection(),
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: "exponential", delay: 1000 },
      removeOnComplete: true, // the code must not linger in Redis after delivery
      removeOnFail: { age: 3600 }, // keep failures for an hour to debug, then drop
    },
  });
}

export async function enqueueOtp(
  queue: Queue<OtpJobData>,
  message: { channel: OtpChannel; to: string; code: string }
): Promise<void> {
  await queue.add("send", {
    channel: message.channel,
    to: message.to,
    codeEnc: encrypt(message.code),
  });
}
