import { describe, expect, it } from "vitest";
import { isPrivateAddress, validateWebhookUrl } from "../../../apps/server/src/lib/webhook-http";

describe("isPrivateAddress (SSRF guard)", () => {
  it.each([
    "127.0.0.1", "10.0.0.5", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254",
    "0.0.0.0", "100.64.0.1", "224.0.0.1", "::1", "::", "fc00::1", "fd12::1", "fe80::1", "::ffff:127.0.0.1", "ff02::1",
  ])("treats %s as private", (ip) => expect(isPrivateAddress(ip)).toBe(true));

  it.each(["8.8.8.8", "1.1.1.1", "172.32.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"])(
    "treats %s as public",
    (ip) => expect(isPrivateAddress(ip)).toBe(false)
  );

  it("refuses things that are not IP addresses", () => expect(isPrivateAddress("example.com")).toBe(true));
});

describe("validateWebhookUrl", () => {
  it("accepts a public https url", () => {
    expect(validateWebhookUrl("https://hooks.example.com/otp", false)).toBeNull();
  });

  it("rejects plain http, credentials, and bad urls", () => {
    expect(validateWebhookUrl("http://hooks.example.com", false)).toMatch(/https/);
    expect(validateWebhookUrl("https://user:pw@hooks.example.com", false)).toMatch(/credentials/);
    expect(validateWebhookUrl("not a url", false)).toMatch(/valid/);
    expect(validateWebhookUrl("ftp://hooks.example.com", false)).toMatch(/https/);
  });

  it("rejects local and private targets", () => {
    for (const url of [
      "https://localhost/x", "https://127.0.0.1/x", "https://169.254.169.254/latest/meta-data",
      "https://10.1.2.3/x", "https://[::1]/x", "https://db.internal/x", "https://app.localhost/x",
    ]) {
      expect(validateWebhookUrl(url, false), url).not.toBeNull();
    }
  });

  it("allows local targets only when private urls are explicitly enabled", () => {
    expect(validateWebhookUrl("http://127.0.0.1:9000/hook", true)).toBeNull();
  });
});
