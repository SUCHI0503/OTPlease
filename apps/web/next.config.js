/* global process */
const isProd = process.env.NODE_ENV === "production";

// The dashboard shows one-time secrets (API keys, webhook secrets), so pages must never be cached or framed.
// The strict CSP is production-only because `next dev` needs eval for hot reload.
const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  { key: "Cache-Control", value: "no-store" },
  ...(isProd
    ? [
        { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
        {
          key: "Content-Security-Policy",
          // Next.js emits small inline scripts for hydration, hence 'unsafe-inline' for scripts
          value:
            "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'self'; object-src 'none'",
        },
      ]
    : []),
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Docker image: a self-contained server in .next/standalone (traced from the repo root for the monorepo)
  ...(process.env.NEXT_STANDALONE === "true" ? { output: "standalone", outputFileTracingRoot: new URL("../..", import.meta.url).pathname } : {}),
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
