import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");

/** Starts the real env validation in a fresh process, exactly as the server does at boot. */
function boot(overrides: Record<string, string | undefined>) {
  const env: Record<string, string | undefined> = { ...process.env, ...overrides };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  const res = spawnSync("npx", ["tsx", "-e", "import('./apps/server/src/lib/env').then(() => console.log('BOOT_OK'))"], {
    cwd: ROOT, env: env as NodeJS.ProcessEnv, encoding: "utf8", timeout: 60_000,
  });
  return { ok: res.status === 0 && res.stdout.includes("BOOT_OK"), output: `${res.stdout}${res.stderr}` };
}

const SECRETS = {
  OTP_HASH_SECRET: "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9",
  JWT_SECRET: "0f9e8d7c6b5a49382716051a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e",
  ADMIN_TOKEN: "5c4b3a291807f6e5d4c3b2a1908f7e6d5c4b3a2918f7e6d5c4b3a2918f7e6d5c",
};

// Each boot() starts a fresh Node process, so these tests get more time than the default
const SLOW = 60_000;

describe("startup refuses unsafe configuration", () => {
  it("boots with valid settings (control)", () => {
    expect(boot(SECRETS).ok).toBe(true);
  }, SLOW);

  it("refuses two secrets that are the same value", () => {
    const r = boot({ ...SECRETS, JWT_SECRET: SECRETS.OTP_HASH_SECRET });
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/must be different from the other secrets/);
  }, SLOW);

  it("refuses placeholder-looking secrets", () => {
    for (const bad of ["changeme".repeat(6), "a".repeat(40), "password-password-password-password", "secret".repeat(8)]) {
      const r = boot({ ...SECRETS, ADMIN_TOKEN: bad });
      expect(r.ok, bad).toBe(false);
      expect(r.output).toMatch(/placeholder/);
    }
  }, SLOW);

  it("refuses too-short secrets and never prints the value it rejected", () => {
    const r = boot({ ...SECRETS, JWT_SECRET: "short-but-unique-1234" });
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/at least 32 characters/);
    expect(r.output).not.toContain("short-but-unique-1234");
  }, SLOW);

  it("refuses an invalid TRUST_PROXY and accepts the valid forms", () => {
    expect(boot({ ...SECRETS, TRUST_PROXY: "banana" }).ok).toBe(false);
    expect(boot({ ...SECRETS, TRUST_PROXY: "0" }).ok).toBe(false);
    expect(boot({ ...SECRETS, TRUST_PROXY: "1" }).ok).toBe(true);
    expect(boot({ ...SECRETS, TRUST_PROXY: "true" }).ok).toBe(true);
  }, SLOW);

  it("refuses wildcard or malformed CORS origins and accepts exact ones", () => {
    for (const bad of ["*", "https://app.example.com/", "https://app.example.com/path", "app.example.com", "https://ok.example.com,*"]) {
      expect(boot({ ...SECRETS, CORS_ORIGINS: bad }).ok, bad).toBe(false);
    }
    expect(boot({ ...SECRETS, CORS_ORIGINS: "https://app.example.com, https://admin.example.com" }).ok).toBe(true);
  }, SLOW);

  it("refuses to start in production with private webhook URLs allowed", () => {
    const r = boot({ ...SECRETS, NODE_ENV: "production", WEBHOOK_ALLOW_PRIVATE_URLS: "true", TWILIO_ACCOUNT_SID: "ACx", TWILIO_AUTH_TOKEN: "x", SMTP_HOST: "smtp.example.com", SMTP_PORT: "587" });
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/must be false in production/);
  }, SLOW);

  it("refuses to start in production on the mock provider", () => {
    const r = boot({ ...SECRETS, NODE_ENV: "production", WEBHOOK_ALLOW_PRIVATE_URLS: "false", TWILIO_ACCOUNT_SID: undefined, TWILIO_AUTH_TOKEN: undefined, SMTP_HOST: undefined });
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/mock provider is not allowed/);
  }, SLOW);

  it("refuses to start with a missing required secret", () => {
    for (const name of Object.keys(SECRETS)) {
      const r = boot({ ...SECRETS, [name]: undefined });
      expect(r.ok, name).toBe(false);
      expect(r.output).toContain(name);
    }
  }, SLOW);
});

// A match only counts if it looks real: fixtures repeat a few characters, real secrets do not
const looksReal = (s: string) => new Set(s).size > 12;
const PATTERNS: [string, RegExp][] = [
  ["OTPlease API key", /otpl_[0-9a-f]{12}_([A-Za-z0-9_-]{30,})/g],
  ["webhook signing secret", /whsec_([A-Za-z0-9_-]{30,})/g],
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----/g],
  ["AWS access key", /AKIA[0-9A-Z]{16}/g],
  ["Twilio account SID", /\bAC[0-9a-f]{32}\b/g],
  ["long hex secret", /\b[0-9a-f]{64}\b/g],
  ["Slack/GitHub token", /\b(?:xox[baprs]-[A-Za-z0-9-]{10,}|gh[pousr]_[A-Za-z0-9]{30,})\b/g],
];

function scan(text: string): string[] {
  const found: string[] = [];
  for (const [name, re] of PATTERNS) {
    for (const m of text.matchAll(re)) if (looksReal(m[1] ?? m[0])) found.push(name);
  }
  return found;
}

describe("no secrets in the repository", () => {
  const tracked = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .filter((f) => !/(package-lock\.json|\.(png|jpg|ico|woff2?|svg))$/.test(f));

  it("does not track any .env file except examples", () => {
    const envFiles = tracked.filter((f) => /(^|\/)\.env(\..+)?$/.test(f) && !f.endsWith(".env.example"));
    expect(envFiles).toEqual([]);
  });

  it("contains no API keys, webhook secrets, private keys or cloud credentials", () => {
    const findings: string[] = [];
    for (const file of tracked) {
      let text: string;
      try { text = readFileSync(path.join(ROOT, file), "utf8"); } catch { continue; }
      for (const name of scan(text)) findings.push(`${file}: ${name}`);
    }
    expect(findings).toEqual([]);
  });

  it("the scan itself works: it flags realistic secrets and ignores obvious fixtures", () => {
    const realKey = `otpl_1a2b3c4d5e6f_aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0hLxR2uY5`;
    const realWebhook = `whsec_kJ8mN2pQ5sT9vW3yZ6cF1hLxR4uY7aB0dE`;
    const realHex = randomBytes(32).toString("hex"); // exactly 64 hex characters, like `openssl rand -hex 32`
    expect(scan(`key=${realKey}`)).toEqual(["OTPlease API key"]);
    expect(scan(`s=${realWebhook}`)).toEqual(["webhook signing secret"]);
    expect(scan(`token: ${realHex}`)).toEqual(["long hex secret"]);
    expect(scan("-----BEGIN RSA PRIVATE KEY-----")).toEqual(["private key"]);
    expect(scan(`AKIA${"IOSFODNN7EXAMPLE"}`)).toEqual(["AWS access key"]);

    // the fixtures used by other tests must not trip it
    expect(scan(`otpl_aaaaaaaaaaaa_${"b".repeat(43)}`)).toEqual([]);
    expect(scan(`otpl_a1b2c3d4e5f6_${"Zx9".repeat(15)}`)).toEqual([]);
    expect(scan("whsec_test_secret")).toEqual([]);
  });

  it("keeps secret-bearing files out of git through .gitignore", () => {
    const ignore = readFileSync(path.join(ROOT, ".gitignore"), "utf8");
    expect(ignore).toMatch(/^\.env$/m);
    expect(ignore).toMatch(/^\.env\.test$/m);
  });
});
