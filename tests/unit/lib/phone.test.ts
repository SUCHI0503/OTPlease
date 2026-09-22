import { describe, expect, it } from "vitest";
import { normalizePhone } from "../../../apps/server/src/lib/phone";

describe("normalizePhone", () => {
  it("formats an international number with spaces", () => {
    expect(normalizePhone("+91 98765 43210")).toBe("+919876543210");
  });

  it("adds the default country code to a national number", () => {
    expect(normalizePhone("9876543210")).toBe("+919876543210");
  });

  it("keeps an already clean E.164 number", () => {
    expect(normalizePhone("+12133734253")).toBe("+12133734253");
  });

  it("rejects a number that is too short", () => {
    expect(normalizePhone("12345")).toBeNull();
  });

  it("rejects text that is not a phone number", () => {
    expect(normalizePhone("hello")).toBeNull();
  });
});
