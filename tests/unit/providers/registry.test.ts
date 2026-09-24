import { describe, expect, it } from "vitest";
import { buildProviders, MockProvider } from "../../../apps/server/src/providers";
import { TwilioProvider } from "../../../apps/server/src/providers/twilio";

describe("buildProviders", () => {
  // The test environment sets fake Twilio credentials and no SMTP host
  const providers = buildProviders();

  it("covers every channel", () => {
    expect(Object.keys(providers).sort()).toEqual(["email", "sms", "voice", "whatsapp"]);
  });

  it("uses Twilio for all phone channels when Twilio is configured", () => {
    for (const channel of ["sms", "whatsapp", "voice"] as const) {
      expect(providers[channel]).toBeInstanceOf(TwilioProvider);
    }
    expect(providers.sms).toBe(providers.whatsapp); // one client serves all three
  });

  it("falls back to the mock provider for email when no SMTP host is set", () => {
    expect(providers.email).toBeInstanceOf(MockProvider);
  });
});
