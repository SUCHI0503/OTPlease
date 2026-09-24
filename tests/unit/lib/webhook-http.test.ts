import { describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { isPrivateAddress, postWebhook, validateWebhookUrl } from "../../../apps/server/src/lib/webhook-http";

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

describe("postWebhook DNS guard", () => {
  async function withReceiver<T>(run: (url: string, received: () => number) => Promise<T>): Promise<T> {
    let hits = 0;
    const server = http.createServer((_req, res) => ((hits += 1), res.end()));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      // "localhost" is a NAME, so this goes through DNS: the case where a hostname points at an internal address
      return await run(`http://localhost:${(server.address() as AddressInfo).port}/hook`, () => hits);
    } finally {
      await new Promise((r) => server.close(r));
    }
  }

  it("refuses a hostname that resolves to a private address, and never connects", async () => {
    await withReceiver(async (url, received) => {
      await expect(postWebhook(url, {}, "{}", { allowPrivate: false })).rejects.toThrow(/private address/);
      expect(received()).toBe(0);
    });
  });

  it("connects to the same hostname when private addresses are explicitly allowed", async () => {
    await withReceiver(async (url, received) => {
      expect(await postWebhook(url, {}, "{}", { allowPrivate: true })).toBe(200);
      expect(received()).toBe(1);
    });
  });

  it("times out instead of hanging on a receiver that never answers", async () => {
    const server = http.createServer(() => { /* never responds */ });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    await expect(postWebhook(url, {}, "{}", { allowPrivate: true, timeoutMs: 300 })).rejects.toThrow(/timeout/);
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
});
