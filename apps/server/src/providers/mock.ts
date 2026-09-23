import type { OtpMessage, OtpProvider, SendResult } from "./types";
import { maskRecipient } from "../lib/mask";
import { env } from "../lib/env";

/**
 * Local-dev provider. Keeps messages in memory (so tests can read the code)
 * and prints them to the terminal only in development.
 * It is the one place a plaintext code is ever shown, and never in production.
 */
export class MockProvider implements OtpProvider {
  readonly outbox: OtpMessage[] = [];

  async send(message: OtpMessage): Promise<SendResult> {
    this.outbox.push(message);
    if (env.NODE_ENV === "development") {
      console.log(`[mock provider] ${message.channel} to ${maskRecipient(message.to)}: code ${message.code}`);
    }
    return { providerMessageId: `mock-${this.outbox.length}` };
  }

  lastCodeFor(to: string): string | undefined {
    return [...this.outbox].reverse().find((m) => m.to === to)?.code;
  }
}
