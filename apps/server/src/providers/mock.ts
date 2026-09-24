import type { OtpMessage, OtpProvider, SendResult } from "./types";
import { maskRecipient } from "../lib/mask";
import { createRedis } from "../lib/redis";
import type { Redis } from "ioredis";
import { env } from "../lib/env";

/**
 * Local-dev provider. Keeps messages in memory (so tests can read the code)
 * and prints them to the terminal only in development.
 * It is the one place a plaintext code is ever shown, and never in production.
 */
export class MockProvider implements OtpProvider {
  readonly outbox: OtpMessage[] = [];
  private outboxRedis?: Redis;

  async send(message: OtpMessage): Promise<SendResult> {
    this.outbox.push(message);
    if (env.MOCK_OUTBOX_REDIS) {
      // Lets a test in another process read the code. Plain text on purpose: development and tests only.
      this.outboxRedis ??= createRedis();
      await this.outboxRedis
        .multi()
        .lpush("mock:outbox", JSON.stringify({ ...message, at: Date.now() }))
        .ltrim("mock:outbox", 0, 199)
        .expire("mock:outbox", 3600)
        .exec();
    }
    if (env.NODE_ENV === "development") {
      console.log(`[mock provider] ${message.channel} to ${maskRecipient(message.to)}: code ${message.code}`);
    }
    return { providerMessageId: `mock-${this.outbox.length}` };
  }

  lastCodeFor(to: string): string | undefined {
    return [...this.outbox].reverse().find((m) => m.to === to)?.code;
  }
}
