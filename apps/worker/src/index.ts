import { prisma } from "../../server/src/lib/prisma";
import { buildProviders } from "../../server/src/providers";
import { startCleanupSchedule } from "./cleanup";
import { createOtpWorker } from "./otp-worker";
import { createWebhookWorker } from "./webhook-worker";
import { createWebhookEmitter, createWebhookQueue } from "../../server/src/queue/webhook-queue";

const log = (msg: string) => console.log(`[worker] ${msg}`);

const webhookQueue = createWebhookQueue();
const otpWorker = createOtpWorker(buildProviders(), createWebhookEmitter(prisma, webhookQueue));
const webhookWorker = createWebhookWorker();
webhookWorker.on("failed", (job, err) => log(`webhook job ${job?.id} failed (attempt ${job?.attemptsMade}): ${err.message}`));
otpWorker.on("failed", (job, err) => {
  // Never log job.data: it holds the recipient
  log(`job ${job?.id} failed (attempt ${job?.attemptsMade}): ${err.message}`);
});

const cleanup = await startCleanupSchedule(prisma, log);
log("started: otp-send + webhooks + cleanup");

async function shutdown() {
  await Promise.all([otpWorker.close(), webhookWorker.close(), webhookQueue.close(), cleanup.worker.close(), cleanup.queue.close()]);
  await prisma.$disconnect();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
