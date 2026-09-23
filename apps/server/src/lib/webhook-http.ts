import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";

/** True for loopback, private, link-local (cloud metadata), multicast and reserved addresses. */
export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b, c] = ip.split(".").map(Number) as [number, number, number];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]!);
    if (lower === "::" || lower === "::1") return true;
    return /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower) || lower.startsWith("ff");
  }
  return true; // not an IP at all: refuse
}

/** Checks a URL as far as possible without the network. DNS is checked again at send time. */
export function validateWebhookUrl(raw: string, allowPrivate: boolean): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "url is not valid";
  }
  if (url.protocol !== "https:" && !(allowPrivate && url.protocol === "http:")) return "url must use https";
  if (url.username || url.password) return "url must not contain credentials";
  if (!allowPrivate) {
    const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) {
      return "url must not point to a local address";
    }
    if (net.isIP(host) && isPrivateAddress(host)) return "url must not point to a private address";
  }
  return null;
}

/**
 * DNS lookup that refuses private addresses. Because the check happens on the
 * address the socket actually connects to, DNS-rebinding cannot swap it afterwards.
 */
function guardedLookup(allowPrivate: boolean): net.LookupFunction {
  return (hostname, options, callback) => {
    dns.lookup(hostname, options, (err, address, family) => {
      if (err) return callback(err, address as never, family as never);
      const list = Array.isArray(address) ? address.map((a) => a.address) : [address];
      if (!allowPrivate && list.some(isPrivateAddress)) {
        return callback(new Error("destination resolves to a private address") as NodeJS.ErrnoException, "" as never, 4 as never);
      }
      callback(null, address as never, family as never);
    });
  };
}

/** POSTs a body and returns the status code. No redirects are followed, and the response body is ignored. */
export function postWebhook(
  rawUrl: string,
  headers: Record<string, string>,
  body: string,
  opts: { allowPrivate: boolean; timeoutMs?: number }
): Promise<number> {
  const url = new URL(rawUrl);
  const lib = url.protocol === "https:" ? https : http;
  // Node does not call `lookup` for IP-literal hosts, so those are checked here
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!opts.allowPrivate && net.isIP(host) && isPrivateAddress(host)) {
    return Promise.reject(new Error("destination resolves to a private address"));
  }
  return new Promise((resolve, reject) => {
    const req = lib.request(
      url,
      {
        method: "POST",
        headers: { ...headers, "content-type": "application/json", "content-length": Buffer.byteLength(body) },
        lookup: guardedLookup(opts.allowPrivate),
        timeout: opts.timeoutMs ?? 5000,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      }
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end(body);
  });
}
