import { describe, expect, it } from "vitest";
import { maskRecipient } from "../../../apps/server/src/lib/mask";
import { hashDevice, hashIp, ipInfo, maskIp, normalizeIp } from "../../../apps/server/src/lib/intelligence";

describe("normalizeIp", () => {
  it("gives one address one form", () => {
    expect(normalizeIp("::FFFF:203.0.113.5")).toBe("203.0.113.5");
    expect(normalizeIp("2001:DB8::1")).toBe("2001:db8::1");
    expect(normalizeIp("fe80::1%eth0")).toBe("fe80::1");
    expect(normalizeIp(" 203.0.113.5 ")).toBe("203.0.113.5");
  });
});

describe("maskIp", () => {
  it("keeps only enough to recognise, not locate", () => {
    expect(maskIp("203.0.113.42")).toBe("203.0.113.*");
    expect(maskIp("2001:db8:1:2::3")).toBe("2001:db8:1:*");
    expect(maskIp("::ffff:203.0.113.42")).toBe("203.0.113.*");
  });
  it("never contains the full address", () => {
    expect(maskIp("203.0.113.42")).not.toContain("42");
  });
});

describe("ipInfo", () => {
  it("reports version and whether the address is private or unroutable", () => {
    expect(ipInfo("8.8.8.8")).toEqual({ version: 4, isPrivate: false });
    expect(ipInfo("192.168.1.10")).toEqual({ version: 4, isPrivate: true });
    expect(ipInfo("127.0.0.1")).toEqual({ version: 4, isPrivate: true });
    expect(ipInfo("2606:4700:4700::1111")).toEqual({ version: 6, isPrivate: false });
    expect(ipInfo("::1")).toEqual({ version: 6, isPrivate: true });
    expect(ipInfo("::ffff:10.0.0.1")).toEqual({ version: 4, isPrivate: true });
  });
});

describe("hashing", () => {
  it("is deterministic and hides the raw value", () => {
    const h = hashDevice("app-1", "device-abc12345");
    expect(h).toBe(hashDevice("app-1", "device-abc12345"));
    expect(h).not.toContain("device-abc12345");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("differs per application, so tenants cannot track a device across each other", () => {
    expect(hashDevice("app-1", "device-abc12345")).not.toBe(hashDevice("app-2", "device-abc12345"));
    expect(hashIp("app-1", "203.0.113.5")).not.toBe(hashIp("app-2", "203.0.113.5"));
  });

  it("treats different spellings of one IP as the same", () => {
    expect(hashIp("app-1", "::ffff:203.0.113.5")).toBe(hashIp("app-1", "203.0.113.5"));
    expect(hashIp("app-1", "2001:DB8::1")).toBe(hashIp("app-1", "2001:db8::1"));
  });

  it("keeps device and IP hashes apart even for identical strings", () => {
    expect(hashDevice("app-1", "203.0.113.5")).not.toBe(hashIp("app-1", "203.0.113.5"));
  });
});

describe("maskRecipient", () => {
  it("hides the middle of a phone number or email, keeping a hint", () => {
    expect(maskRecipient("+919876543210")).toBe("+91********10");
    expect(maskRecipient("+919876543210")).not.toContain("98765");
  });
  it("fully hides very short values", () => {
    expect(maskRecipient("1234")).toBe("****");
    expect(maskRecipient("")).toBe("****");
  });
});
