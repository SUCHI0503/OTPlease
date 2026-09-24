/* global process */
const isProd = process.env.NODE_ENV === "production";

// Same protections as the dashboard: pages here show account details, so nothing is cached or framed
const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "Cache-Control", value: "no-store" },
  ...(isProd
    ? [{ key: "Content-Security-Policy", value: "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; form-action 'self'; base-uri 'self'" }]
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
