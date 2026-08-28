import { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";
import { withWorkflow } from "workflow/next";

const nextConfig: NextConfig = {
  // Produce .next/standalone ONLY for the client kernel packaging build
  // (NEXT_PUBLIC_PREVIOUSLY_TARGET=client, set by scripts/build-standalone.mjs —
  // see doc/design/v0.9-client.md §6). It MUST stay off cloud deploys: Next
  // 16.3 + standalone breaks Vercel's onBuildComplete (the adapter build skips
  // the whole-server trace file, then packaging reads it — ENOENT
  // .next/next-server.js.nft.json, vercel/next.js#96646).
  output:
    process.env.NEXT_PUBLIC_PREVIOUSLY_TARGET === "client"
      ? "standalone"
      : undefined,
  // Keep runtime data directories out of the standalone trace. `memory/` is
  // traced only because getMemoryRoot()/demo-fs resolve paths dynamically via
  // `join(process.cwd(), ...)` — at runtime client mode re-roots memory at
  // MEMORY_ROOT and demo-fs reads `<cwd>/../benchmark-data`, so neither reads
  // the copies Next would ship inside .next/standalone. Shipping them bloats
  // the @previously-lab/kernel artifact with local dev data.
  outputFileTracingExcludes: {
    "*": ["./memory/**/*", "./benchmark-data/**/*"],
  },
  turbopack: {
    root: process.cwd(),
  },
  // ajv (pulled in by @ai-sdk/workflow for tool contextSchema validation)
  // uses dynamic require(), which Turbopack can't bundle into the generated
  // .well-known/workflow step route — keep it external and let Node require
  // it at runtime.
  serverExternalPackages: ["ajv"],
  // Docs moved to the official site — permanently redirect all in-app docs
  // URLs (bare and locale-prefixed) to https://previously.ldwid.com.
  async redirects() {
    return [
      {
        source: "/docs/:path*",
        destination: "https://previously.ldwid.com/docs/:path*",
        permanent: true,
      },
      {
        source: "/en/docs/:path*",
        destination: "https://previously.ldwid.com/en/docs/:path*",
        permanent: true,
      },
      {
        source: "/zh/docs/:path*",
        destination: "https://previously.ldwid.com/zh/docs/:path*",
        permanent: true,
      },
    ];
  },
};

const withNextIntl = createNextIntlPlugin();
export default withWorkflow(withNextIntl(nextConfig));
