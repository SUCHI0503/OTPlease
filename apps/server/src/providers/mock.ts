import type { OtpMessage, OtpProvider } from "./types";
import { env } from "../lib/env";

export function maskRecipient(to: string): string {
  return to.length <= 4 ? "****" : `${to.slice(0, 3)}${"*".repeat(to.length - 5)}${to.slice(-2)}`;
}

/**
 * Local-dev provider. Keeps messages in memory (so tests can read the code)
 * and prints them to the terminal only in development.
 * It is the one place a plaintext code is ever shown, and never in production.
 */
export class MockProvider implements OtpProvider {
  readonly outbox: OtpMessage[] = [];

  async send(message: OtpMessage): Promise<void> {
    this.outbox.push(message);
    if (env.NODE_ENV === "development") {
      console.log(`[mock provider] ${message.channel} to ${maskRecipient(message.to)}: code ${message.code}`);
    }
  }

  lastCodeFor(to: string): string | undefined {
    return [...this.outbox].reverse().find((m) => m.to === to)?.code;
  }
}
