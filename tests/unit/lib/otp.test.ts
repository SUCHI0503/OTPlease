import { describe, it, expect } from "vitest";
import { generateOtpCode, hashOtpCode, verifyOtpCode } from "../../../apps/server/src/lib/otp";

describe("generateOtpCode", () => {
  it("always returns a 6-digit numeric string", () => {
    for (let i = 0; i < 50; i++) {
      const code = generateOtpCode();
      expect(code).toMatch(/^\d{6}$/);
    }
  });
});

describe("hashOtpCode / verifyOtpCode", () => {
  it("produces a hash that verifies successfully against the original code", () => {
    const code = "123456";
    const hash = hashOtpCode(code);
    expect(verifyOtpCode(code, hash)).toBe(true);
  });

  it("rejects a wrong code against a valid hash", () => {
    const hash = hashOtpCode("123456");
    expect(verifyOtpCode("654321", hash)).toBe(false);
  });

  it("produces different hashes for different codes", () => {
    const hashA = hashOtpCode("111111");
    const hashB = hashOtpCode("222222");
    expect(hashA).not.toBe(hashB);
  });

  it("produces the same hash for the same code (deterministic)", () => {
    const hashA = hashOtpCode("999999");
    const hashB = hashOtpCode("999999");
    expect(hashA).toBe(hashB);
  });
});
